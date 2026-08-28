import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	type ApiClient,
	type Config,
	evaluateNotification,
	type NotificationThread,
	parseCliOptions,
	runJanitor,
	validateConfig
} from './notification-janitor.ts'

const LATEST_COMMENT_URL = 'https://api.github.com/repos/acme/widgets/issues/comments/10'
const SUBJECT_URL = 'https://api.github.com/repos/acme/widgets/pulls/42'

function config(overrides: Partial<Config> = {}): Config {
	return {
		version: 1,
		dryRun: true,
		maxNotifications: 200,
		notificationLookbackHours: 30,
		maxActivityPages: 20,
		notificationCommentSkewSeconds: 120,
		concurrency: 5,
		rules: [
			{
				name: 'GitHub Actions comments on my threads',
				commentAuthors: ['github-actions[bot]'],
				threadAuthors: ['@me'],
				subjectTypes: ['Issue', 'PullRequest'],
				action: 'done'
			}
		],
		...overrides
	}
}

function notification(overrides: Partial<NotificationThread> = {}): NotificationThread {
	return {
		id: '12345',
		unread: true,
		reason: 'author',
		updated_at: '2026-08-28T10:00:00Z',
		last_read_at: '2026-08-28T09:00:00Z',
		repository: {
			full_name: 'acme/widgets'
		},
		subject: {
			title: 'Private title that must not reach logs',
			type: 'PullRequest',
			url: SUBJECT_URL,
			latest_comment_url: LATEST_COMMENT_URL
		},
		...overrides
	}
}

class FakeClient implements ApiClient {
	readonly requests: Array<{ endpoint: string; method: string }> = []
	readonly paginationRequests: string[] = []
	readonly responses = new Map<string, unknown>()
	readonly pages = new Map<string, unknown[]>()

	async request<T>(endpoint: string, options: { method?: 'GET' | 'DELETE' } = {}): Promise<T> {
		const method = options.method ?? 'GET'
		this.requests.push({ endpoint, method })

		if (method === 'DELETE') {
			return undefined as T
		}

		if (!this.responses.has(endpoint)) {
			throw new Error(`Missing fake response for ${endpoint}`)
		}

		return this.responses.get(endpoint) as T
	}

	async paginate<T>(endpoint: string): Promise<T[]> {
		this.paginationRequests.push(endpoint)
		const entry = [...this.pages.entries()].find(([prefix]) => endpoint.startsWith(prefix))

		if (!entry) {
			throw new Error(`Missing fake page for ${endpoint}`)
		}

		return entry[1] as T[]
	}
}

function botComment(timestamp = '2026-08-28T10:00:00Z') {
	return {
		id: 10,
		user: { login: 'github-actions[bot]', type: 'Bot' },
		created_at: timestamp,
		updated_at: timestamp
	}
}

function humanComment(timestamp = '2026-08-28T09:30:00Z') {
	return {
		id: 11,
		user: { login: 'helpful-human', type: 'User' },
		created_at: timestamp,
		updated_at: timestamp
	}
}

function viewerComment(timestamp = '2026-08-28T09:30:00Z') {
	return {
		id: 12,
		user: { login: 'hyldmo', type: 'User' },
		created_at: timestamp,
		updated_at: timestamp
	}
}

function readyClient(thread = notification(), activities: unknown[] = [botComment()]): FakeClient {
	const client = new FakeClient()
	client.responses.set(LATEST_COMMENT_URL, botComment())
	client.responses.set(SUBJECT_URL, {
		user: { login: 'hyldmo', type: 'User' }
	})
	client.responses.set('/notifications/threads/12345', thread)
	client.pages.set('/repos/acme/widgets/issues/42/comments', activities)
	client.pages.set('/repos/acme/widgets/pulls/42/comments', [])
	client.pages.set('/repos/acme/widgets/pulls/42/reviews', [])
	return client
}

test('validates and normalizes a configuration', () => {
	const result = validateConfig({
		version: 1,
		dryRun: true,
		rules: [
			{
				name: 'Bots',
				commentAuthors: ['GitHub-Actions[Bot]'],
				threadAuthors: ['@ME']
			}
		]
	})

	assert.equal(result.maxNotifications, 200)
	assert.equal(result.notificationLookbackHours, 30)
	assert.equal(result.concurrency, 5)
	assert.deepEqual(result.rules[0]?.commentAuthors, ['github-actions[bot]'])
	assert.deepEqual(result.rules[0]?.threadAuthors, ['@me'])
	assert.deepEqual(result.rules[0]?.subjectTypes, ['Issue', 'PullRequest'])
})

test('rejects unknown configuration fields', () => {
	assert.throws(
		() =>
			validateConfig({
				version: 1,
				dryRun: true,
				repositories: ['hyldmo/*'],
				rules: []
			}),
		/unknown field: repositories/
	)
})

test('requires comment authors for Issue and PullRequest rules', () => {
	assert.throws(
		() =>
			validateConfig({
				version: 1,
				dryRun: true,
				rules: [
					{
						name: 'Incomplete pull request rule',
						subjectTypes: ['PullRequest']
					}
				]
			}),
		/requires commentAuthors or stateChangeAuthors/
	)
})

test('matches bot-only activity on a thread created by the viewer', async () => {
	const thread = notification()
	const result = await evaluateNotification(readyClient(thread), thread, config(), 'hyldmo')

	assert.deepEqual(result, {
		decision: 'done',
		commentAuthor: 'github-actions[bot]',
		matchedRules: ['GitHub Actions comments on my threads']
	})
})

test('matches a state change made by the viewer on the viewer’s pull request', async () => {
	const thread = notification({
		updated_at: '2026-08-28T10:00:00Z',
		last_read_at: '2026-08-28T09:00:00Z'
	})
	const client = readyClient(thread, [])
	client.pages.set('/repos/acme/widgets/issues/42/timeline', [
		{
			event: 'merged',
			actor: { login: 'hyldmo', type: 'User' },
			created_at: '2026-08-28T09:59:30Z'
		}
	])
	const stateChangeConfig = config({
		rules: [
			{
				name: 'My pull request state changes',
				stateChangeAuthors: ['@me'],
				threadAuthors: ['@me'],
				subjectTypes: ['PullRequest'],
				action: 'done'
			}
		]
	})

	const result = await evaluateNotification(client, thread, stateChangeConfig, 'hyldmo')

	assert.deepEqual(result, {
		decision: 'done',
		commentAuthor: 'hyldmo',
		matchedRules: ['My pull request state changes']
	})
})

test('matches a state change notification with a comment by the viewer', async () => {
	const thread = notification({
		updated_at: '2026-08-28T10:00:00Z',
		last_read_at: '2026-08-28T09:00:00Z'
	})
	const client = readyClient(thread, [viewerComment()])
	client.pages.set('/repos/acme/widgets/issues/42/timeline', [
		{
			event: 'merged',
			actor: { login: 'hyldmo', type: 'User' },
			created_at: '2026-08-28T09:59:30Z'
		}
	])
	const stateChangeConfig = config({
		rules: [
			{
				name: 'My pull request state changes',
				stateChangeAuthors: ['@me'],
				threadAuthors: ['@me'],
				subjectTypes: ['PullRequest'],
				action: 'done'
			}
		]
	})

	const result = await evaluateNotification(client, thread, stateChangeConfig, 'hyldmo')

	assert.deepEqual(result, {
		decision: 'done',
		commentAuthor: 'hyldmo',
		matchedRules: ['My pull request state changes']
	})
})

test('preserves a state change notification with a human comment after the last read', async () => {
	const thread = notification({
		updated_at: '2026-08-28T10:00:00Z',
		last_read_at: '2026-08-28T09:00:00Z'
	})
	const client = readyClient(thread, [humanComment('2026-08-28T09:30:00Z')])
	client.pages.set('/repos/acme/widgets/issues/42/timeline', [
		{
			event: 'merged',
			actor: { login: 'hyldmo', type: 'User' },
			created_at: '2026-08-28T09:59:30Z'
		}
	])
	const stateChangeConfig = config({
		rules: [
			{
				name: 'My pull request state changes',
				stateChangeAuthors: ['@me'],
				threadAuthors: ['@me'],
				subjectTypes: ['PullRequest'],
				action: 'done'
			}
		]
	})

	const result = await evaluateNotification(client, thread, stateChangeConfig, 'hyldmo')

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'human-activity-after-last-read'
	})
})

test('matches a release rule without fetching a comment or release', async () => {
	const thread = notification({
		subject: {
			title: 'v1.2.3',
			type: 'Release',
			url: 'https://api.github.com/repos/acme/widgets/releases/99',
			latest_comment_url: 'https://api.github.com/repos/acme/widgets/releases/99'
		}
	})
	const client = readyClient(thread)
	const releaseConfig = config({
		rules: [
			{
				name: 'Keep one release notification per repository each week',
				subjectTypes: ['Release'],
				releaseRetention: 'latest-per-repository-per-week',
				action: 'done'
			}
		]
	})

	const result = await evaluateNotification(client, thread, releaseConfig, 'hyldmo')

	assert.deepEqual(result, {
		decision: 'done',
		commentAuthor: 'release',
		matchedRules: ['Keep one release notification per repository each week']
	})
	assert.deepEqual(client.requests, [{ endpoint: '/notifications/threads/12345', method: 'GET' }])
})

test('keeps the latest release notification for its repository and week', async () => {
	const thread = notification({
		subject: {
			title: 'v1.2.3',
			type: 'Release',
			url: 'https://api.github.com/repos/acme/widgets/releases/99',
			latest_comment_url: 'https://api.github.com/repos/acme/widgets/releases/99'
		}
	})
	const client = readyClient(thread)
	const releaseConfig = config({
		rules: [
			{
				name: 'Keep one release notification per repository each week',
				subjectTypes: ['Release'],
				releaseRetention: 'latest-per-repository-per-week',
				action: 'done'
			}
		]
	})

	const result = await evaluateNotification(client, thread, releaseConfig, 'hyldmo', new Set([thread.id]))

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'release-retained-for-week'
	})
	assert.deepEqual(client.requests, [])
})

test('marks older releases from the same repository and week Done', async () => {
	const olderRelease = notification({
		id: 'older-release',
		updated_at: '2026-08-18T10:00:00Z',
		subject: {
			title: 'v1.2.2',
			type: 'Release',
			url: 'https://api.github.com/repos/acme/widgets/releases/98',
			latest_comment_url: 'https://api.github.com/repos/acme/widgets/releases/98'
		}
	})
	const latestRelease = notification({
		id: 'latest-release',
		updated_at: '2026-08-19T10:00:00Z',
		subject: {
			title: 'v1.2.3',
			type: 'Release',
			url: 'https://api.github.com/repos/acme/widgets/releases/99',
			latest_comment_url: 'https://api.github.com/repos/acme/widgets/releases/99'
		}
	})
	const client = readyClient(olderRelease)
	client.responses.set('/user', { login: 'hyldmo' })
	client.responses.set('/notifications/threads/older-release', olderRelease)
	client.pages.set('/notifications?all=true&per_page=50', [olderRelease, latestRelease])
	const releaseConfig = config({
		rules: [
			{
				name: 'Keep one release notification per repository each week',
				subjectTypes: ['Release'],
				releaseRetention: 'latest-per-repository-per-week',
				action: 'done'
			}
		]
	})

	const summary = await runJanitor(client, releaseConfig)

	assert.equal(summary.candidates, 1)
	assert.equal(summary.completed, 0)
	assert.equal(summary.skipped.get('release-retained-for-week'), 1)
})

test('preserves a notification with human activity after the last read', async () => {
	const thread = notification()
	const result = await evaluateNotification(
		readyClient(thread, [humanComment(), botComment()]),
		thread,
		config(),
		'hyldmo'
	)

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'human-activity-after-last-read'
	})
})

test('preserves an unread thread with any historical human activity', async () => {
	const thread = notification({ last_read_at: null })
	const result = await evaluateNotification(
		readyClient(thread, [humanComment('2026-08-20T09:00:00Z'), botComment()]),
		thread,
		config(),
		'hyldmo'
	)

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'human-activity-after-last-read'
	})
})

test('preserves activity on a thread created by another user', async () => {
	const thread = notification()
	const client = readyClient(thread)
	client.responses.set(SUBJECT_URL, {
		user: { login: 'another-user', type: 'User' }
	})

	const result = await evaluateNotification(client, thread, config(), 'hyldmo')

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'thread-outside-rule-scope'
	})
})

test('preserves a thread that changes while it is checked', async () => {
	const thread = notification()
	const changedThread = notification({
		updated_at: '2026-08-28T10:01:00Z'
	})
	const client = readyClient(thread)
	client.responses.set('/notifications/threads/12345', changedThread)

	const result = await evaluateNotification(client, thread, config(), 'hyldmo')

	assert.deepEqual(result, {
		decision: 'skip',
		reason: 'thread-changed-during-check'
	})
})

test('dry-run reports a candidate without marking it Done', async () => {
	const thread = notification()
	const client = readyClient(thread)
	client.responses.set('/user', { login: 'hyldmo' })
	client.pages.set('/notifications?all=true&per_page=50', [thread])

	const summary = await runJanitor(client, config({ dryRun: true }), new Date('2026-08-28T12:00:00Z'))

	assert.equal(summary.candidates, 1)
	assert.equal(summary.completed, 0)
	assert.equal(
		client.paginationRequests[0],
		'/notifications?all=true&per_page=50&since=2026-08-27T06%3A00%3A00.000Z'
	)
	assert.equal(
		client.requests.some(request => request.method === 'DELETE'),
		false
	)
})

test('apply mode marks a matching notification Done', async () => {
	const thread = notification({ unread: false })
	const client = readyClient(thread)
	client.responses.set('/user', { login: 'hyldmo' })
	client.pages.set('/notifications?all=true&per_page=50', [thread])

	const summary = await runJanitor(client, config({ dryRun: false }), new Date('2026-08-28T12:00:00Z'))

	assert.equal(summary.completed, 1)
	assert.equal(
		client.requests.some(request => request.method === 'DELETE' && request.endpoint === '/notifications/threads/12345'),
		true
	)
})

test('parses manual dry-run and apply flags', () => {
	assert.equal(parseCliOptions(['--dry-run']).dryRunOverride, true)
	assert.equal(parseCliOptions(['--apply']).dryRunOverride, false)
	assert.throws(() => parseCliOptions(['--dry-run', '--apply']), /cannot be combined/)
})
