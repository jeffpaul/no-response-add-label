import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as scramjet from 'scramjet'

import Config from './config'
import { GitHub } from '@actions/github/lib/utils'

/* eslint-disable import/no-unresolved, import/named */
import { RequestInterface } from '@octokit/types'
import { IssueCommentEvent, IssuesEvent } from '@octokit/webhooks-types'
/* eslint-enable */

const fsp = fs.promises

interface Issue {
  issue_number: number
  owner: string
  repo: string
}

interface LabeledEvent {
  created_at: number
  event: string
  label: {
    name: string
  }
}

interface RestIssue {
  number: number
}

export default class NoResponse {
  config: Config
  octokit: InstanceType<typeof GitHub>

  constructor(config: Config) {
    this.config = config
    this.octokit = github.getOctokit(this.config.token)
  }

  async sweep(): Promise<void> {
    core.debug('Starting sweep')

    await this.ensureLabelExists(
      this.config.responseRequiredLabel,
      this.config.responseRequiredColor
    )

    const issues = await this.getCloseableIssues()

    for (const issue of issues) {
      this.close({ issue_number: issue.number, ...this.config.repo })
    }
  }

  async removeLabels(): Promise<void> {
    core.debug('Starting removeLabels')

    const { optionalFollowUpLabel, responseRequiredLabel } = this.config
    if (!optionalFollowUpLabel) {
      return
    }
    const payload = github.context.payload as IssuesEvent
    if (payload.action !== 'closed') {
      return
    }
    const owner = payload.repository.owner.login
    const repo = payload.repository.name
    const { number } = payload.issue
    const issue = { owner, repo, issue_number: number }

    // if the issue closed by the issue author, check if optionalFollowUpLabel is present on the issue and then remove it
    if (payload.action === 'closed' && payload.issue.user.login === payload.sender.login) {
      const labels = await this.octokit.rest.issues.listLabelsOnIssue(issue)
      const plainLabels = labels.data.map((label: any) => label.name)

      if (plainLabels.includes(responseRequiredLabel)) {
        await this.octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: number,
          name: responseRequiredLabel
        })
      }

      if (plainLabels.includes(optionalFollowUpLabel)) {
        await this.octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: number,
          name: optionalFollowUpLabel
        })
      }
    }
  }

  async unmark(): Promise<void> {
    core.debug('Starting unmark')

    const { responseRequiredLabel, optionalFollowUpLabel, optionalFollowUpLabelColor } = this.config
    const payload: IssueCommentEvent = await this.readPayload()
    const owner = payload.repository.owner.login
    const repo = payload.repository.name
    const { number } = payload.issue
    const comment = payload.comment
    const issue = { owner, repo, issue_number: number }

    const issueInfo = await this.octokit.rest.issues.get(issue)
    const isMarked = await this.hasResponseRequiredLabel(issue)

    if (isMarked && issueInfo.data.user?.login === comment.user.login) {
      core.info(`${owner}/${repo}#${number} is being unmarked`)

      await this.octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: number,
        name: responseRequiredLabel
      })

      if (optionalFollowUpLabel) {
        await this.ensureLabelExists(optionalFollowUpLabel, optionalFollowUpLabelColor || 'ffffff')
        await this.octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: number,
          labels: [optionalFollowUpLabel]
        })
      }

      if (
        issueInfo.data.state === 'closed' &&
        issueInfo.data.user.login !== issueInfo.data.closed_by?.login
      ) {
        this.octokit.rest.issues.update({ owner, repo, issue_number: number, state: 'open' })
      }
    }
  }

  async close(issue: Issue): Promise<void> {
    const { closeComment } = this.config

    core.info(`${issue.owner}/${issue.repo}#${issue.issue_number} is being closed`)

    if (closeComment) {
      await this.octokit.rest.issues.createComment({ body: closeComment, ...issue })
    }

    await this.octokit.rest.issues.update({ state: 'closed', state_reason: 'inactivity', ...issue })
  }

  async ensureLabelExists(name: string, color: string): Promise<void> {
    try {
      await this.octokit.rest.issues.getLabel({
        name,
        ...this.config.repo
      })
    } catch (e) {
      this.octokit.rest.issues.createLabel({
        name,
        color,
        ...this.config.repo
      })
    }
  }

  async findLastLabeledEvent(issue: Issue): Promise<LabeledEvent | undefined> {
    const { responseRequiredLabel } = this.config
    const events: LabeledEvent[] = await this.octokit.paginate(
      (await this.octokit.rest.issues.listEvents({
        ...issue,
        per_page: 100
      })) as unknown as RequestInterface<object>
    )

    return events
      .reverse()
      .find((event) => event.event === 'labeled' && event.label.name === responseRequiredLabel)
  }

  async getCloseableIssues(): Promise<RestIssue[]> {
    const { owner, repo } = this.config.repo
    const { daysUntilClose, responseRequiredLabel } = this.config
    const q = `repo:${owner}/${repo} is:issue is:open label:"${responseRequiredLabel}"`
    const labeledEarlierThan = this.since(daysUntilClose)

    const issues = await this.octokit.rest.search.issuesAndPullRequests({
      q,
      sort: 'updated',
      order: 'asc',
      per_page: 30
    })

    core.debug(`Issues to check for closing:`)
    core.debug(JSON.stringify(issues, null, 2))

    const closableIssues = await scramjet
      .fromArray(issues.data.items)
      .filter(async (issue) => {
        const event = await this.findLastLabeledEvent({
          issue_number: issue.number,
          ...this.config.repo
        })

        if (!event) {
          return false
        }

        core.debug(`Checking: ${JSON.stringify(issue, null, 2)}`)
        core.debug(`Using: ${JSON.stringify(event, null, 2)}`)

        const creationDate = new Date(event.created_at)

        core.debug(
          `${creationDate.toISOString()} < ${labeledEarlierThan.toISOString()} === ${
            creationDate < labeledEarlierThan
          }`
        )

        return creationDate < labeledEarlierThan
      })
      .toArray()

    core.debug(`Closeable: ${JSON.stringify(closableIssues, null, 2)}`)

    return closableIssues
  }

  async hasResponseRequiredLabel(issue: Issue): Promise<boolean> {
    const labels = await this.octokit.rest.issues.listLabelsOnIssue({ ...issue })

    return labels.data.map((label: any) => label.name).includes(this.config.responseRequiredLabel)
  }

  async readPayload(): Promise<IssueCommentEvent> {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error('GITHUB_EVENT_PATH is not defined')
    }

    const text = (await fsp.readFile(process.env.GITHUB_EVENT_PATH)).toString()

    return JSON.parse(text)
  }

  since(days: number): Date {
    const ttl = days * 24 * 60 * 60 * 1000

    return new Date(new Date().getTime() - ttl)
  }
}
