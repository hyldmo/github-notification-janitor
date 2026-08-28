#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2026-03-10'
const DEFAULT_CONFIG_PATH = '.github/notification-janitor.json'

const SUBJECT_TYPES = ['Issue', 'PullRequest', 'Release'] as const
const DEFAULT_SUBJECT_TYPES = ['Issue', 'PullRequest'] as const
const STATE_CHANGE_EVENTS = new Set([
	'base_ref_changed',
	'closed',
	'converted_to_draft',
	'head_ref_deleted',
	'locked',
	'merged',
	'ready_for_review',
	'renamed',
	'reopened',
	'unlocked'
])

type SubjectType = (typeof SUBJECT_TYPES)[number]
type JanitorAction = 'done'
type ReleaseRetention = 'latest-per-repository-per-week'

export interface Rule {
	name: string
	commentAuthors?: string[]
	stateChangeAuthors?: string[]
	threadAuthors?: string[]
	subjectTypes: SubjectType[]
	releaseRetention?: ReleaseRetention
	action: JanitorAction
}

export interface Config {
	version: 1
	dryRun: boolean
	maxNotifications: number
	notificationLookbackHours: number
	maxActivityPages: number
	notificationCommentSkewSeconds: number
	concurrency: number
	rules: Rule[]
}

interface Actor {
	login?: string | null
	type?: string | null
}

interface SubjectResource {
	user?: Actor | null
}

interface CommentResource {
	id?: number | string
	user?: Actor | null
	created_at?: string | null
	updated_at?: string | null
	submitted_at?: string | null
}

interface TimelineEvent {
	event?: string | null
	actor?: Actor | null
	created_at?: string | null
}

export interface NotificationThread {
	id: string
	unread: boolean
	reason: string
	updated_at: string
	last_read_at: string | null
	repository: {
		full_name: string
	}
	subject: {
		title: string
		type: string
		url: string | null
		latest_comment_url: string | null
	}
}

interface Viewer {
	login: string
}

interface PaginationOptions {
	maxItems?: number
	maxPages?: number
	failOnTruncation?: boolean
}

interface RequestOptions {
	method?: 'GET' | 'DELETE'
}

export interface ApiClient {
	request<T>(endpoint: string, options?: RequestOptions): Promise<T>
	paginate<T>(endpoint: string, options?: PaginationOptions): Promise<T[]>
}

interface Activity {
	author: string | null
	timestamp: string | null
}

interface StateChange extends Activity {
	event: string | null
}

export type Evaluation =
	| {
			decision: 'done'
			commentAuthor: string
			matchedRules: string[]
	  }
	| {
			decision: 'skip'
			reason: string
	  }

interface RunSummary {
	scanned: number
	candidates: number
	completed: number
	errors: number
	dryRun: boolean
	skipped: Map<string, number>
}

interface CliOptions {
	configPath: string
	dryRunOverride?: boolean
	help: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertObjectKeys(value: Record<string, unknown>, allowedKeys: string[], context: string): void {
	const unexpected = Object.keys(value).filter(key => !allowedKeys.includes(key))

	if (unexpected.length > 0) {
		throw new Error(`${context} contains unknown field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}`)
	}
}

function requireString(value: unknown, context: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${context} must be a non-empty string`)
	}

	return value.trim()
}

function requireStringArray(value: unknown, context: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${context} must be a non-empty array`)
	}

	const result = value.map((item, index) => requireString(item, `${context}[${index}]`))

	if (new Set(result.map(normalizeLogin)).size !== result.length) {
		throw new Error(`${context} contains duplicate values`)
	}

	return result
}

function optionalInteger(value: unknown, fallback: number, context: string, minimum: number, maximum: number): number {
	if (value === undefined) {
		return fallback
	}

	if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${context} must be an integer from ${minimum} through ${maximum}`)
	}

	return value
}

export function normalizeLogin(login: string): string {
	return login.trim().toLowerCase()
}

export function validateConfig(value: unknown): Config {
	if (!isRecord(value)) {
		throw new Error('Configuration must be a JSON object')
	}

	assertObjectKeys(
		value,
		[
			'version',
			'dryRun',
			'maxNotifications',
			'notificationLookbackHours',
			'maxActivityPages',
			'notificationCommentSkewSeconds',
			'concurrency',
			'rules'
		],
		'Configuration'
	)

	if (value.version !== 1) {
		throw new Error('Configuration version must be 1')
	}

	if (typeof value.dryRun !== 'boolean') {
		throw new Error('Configuration dryRun must be a boolean')
	}

	if (!Array.isArray(value.rules) || value.rules.length === 0) {
		throw new Error('Configuration rules must be a non-empty array')
	}

	const rules = value.rules.map((rawRule, index): Rule => {
		const context = `rules[${index}]`

		if (!isRecord(rawRule)) {
			throw new Error(`${context} must be an object`)
		}

		assertObjectKeys(
			rawRule,
			[
				'name',
				'commentAuthors',
				'stateChangeAuthors',
				'threadAuthors',
				'subjectTypes',
				'releaseRetention',
				'action'
			],
			context
		)

		const name = requireString(rawRule.name, `${context}.name`)
		const commentAuthors =
			rawRule.commentAuthors === undefined
				? []
				: requireStringArray(rawRule.commentAuthors, `${context}.commentAuthors`).map(normalizeLogin)
		const stateChangeAuthors =
			rawRule.stateChangeAuthors === undefined
				? []
				: requireStringArray(rawRule.stateChangeAuthors, `${context}.stateChangeAuthors`).map(normalizeLogin)
		const threadAuthors =
			rawRule.threadAuthors === undefined
				? undefined
				: requireStringArray(rawRule.threadAuthors, `${context}.threadAuthors`).map(normalizeLogin)

		let subjectTypes: SubjectType[] = [...DEFAULT_SUBJECT_TYPES]
		if (rawRule.subjectTypes !== undefined) {
			const rawSubjectTypes = requireStringArray(rawRule.subjectTypes, `${context}.subjectTypes`)
			const invalid = rawSubjectTypes.filter(subjectType => !SUBJECT_TYPES.includes(subjectType as SubjectType))

			if (invalid.length > 0) {
				throw new Error(`${context}.subjectTypes contains unsupported values: ${invalid.join(', ')}`)
			}

			subjectTypes = rawSubjectTypes as SubjectType[]
		}

		if (
			subjectTypes.some(subjectType => subjectType !== 'Release') &&
			commentAuthors.length === 0 &&
			stateChangeAuthors.length === 0
		) {
			throw new Error(`${context} requires commentAuthors or stateChangeAuthors for Issue and PullRequest rules`)
		}

		if (stateChangeAuthors.length > 0 && (subjectTypes.length !== 1 || subjectTypes[0] !== 'PullRequest')) {
			throw new Error(`${context}.stateChangeAuthors requires subjectTypes to be ["PullRequest"]`)
		}

		const releaseRetention = rawRule.releaseRetention
		if (releaseRetention !== undefined && releaseRetention !== 'latest-per-repository-per-week') {
			throw new Error(`${context}.releaseRetention must be "latest-per-repository-per-week"`)
		}

		if (releaseRetention !== undefined && (subjectTypes.length !== 1 || subjectTypes[0] !== 'Release')) {
			throw new Error(`${context}.releaseRetention requires subjectTypes to be ["Release"]`)
		}

		if (releaseRetention !== undefined && threadAuthors !== undefined) {
			throw new Error(`${context}.releaseRetention does not support threadAuthors`)
		}

		const action = rawRule.action ?? 'done'
		if (action !== 'done') {
			throw new Error(`${context}.action must be "done"`)
		}

		return {
			name,
			commentAuthors,
			stateChangeAuthors,
			threadAuthors,
			subjectTypes,
			releaseRetention,
			action
		}
	})

	const normalizedNames = rules.map(rule => rule.name.toLowerCase())
	if (new Set(normalizedNames).size !== normalizedNames.length) {
		throw new Error('Rule names must be unique')
	}

	return {
		version: 1,
		dryRun: value.dryRun,
		maxNotifications: optionalInteger(value.maxNotifications, 200, 'Configuration maxNotifications', 1, 1_000),
		notificationLookbackHours: optionalInteger(
			value.notificationLookbackHours,
			30,
			'Configuration notificationLookbackHours',
			1,
			168
		),
		maxActivityPages: optionalInteger(value.maxActivityPages, 20, 'Configuration maxActivityPages', 1, 100),
		notificationCommentSkewSeconds: optionalInteger(
			value.notificationCommentSkewSeconds,
			120,
			'Configuration notificationCommentSkewSeconds',
			0,
			3_600
		),
		concurrency: optionalInteger(value.concurrency, 5, 'Configuration concurrency', 1, 10),
		rules
	}
}

function actorLogin(actor: Actor | null | undefined): string | null {
	if (typeof actor?.login !== 'string' || actor.login.trim() === '') {
		return null
	}

	return normalizeLogin(actor.login)
}

function activityTimestamp(resource: CommentResource): string | null {
	return resource.updated_at ?? resource.submitted_at ?? resource.created_at ?? null
}

function parseTimestamp(timestamp: string | null): number | null {
	if (timestamp === null) {
		return null
	}

	const parsed = Date.parse(timestamp)
	return Number.isFinite(parsed) ? parsed : null
}

function timestampsAreClose(first: string | null, second: string | null, maximumSkewSeconds: number): boolean {
	const firstTimestamp = parseTimestamp(first)
	const secondTimestamp = parseTimestamp(second)

	if (firstTimestamp === null || secondTimestamp === null) {
		return false
	}

	return Math.abs(firstTimestamp - secondTimestamp) <= maximumSkewSeconds * 1_000
}

function activityIsAfter(activity: Activity, cutoff: string | null): boolean {
	if (cutoff === null) {
		return true
	}

	const activityTime = parseTimestamp(activity.timestamp)
	const cutoffTime = parseTimestamp(cutoff)

	if (activityTime === null || cutoffTime === null) {
		return true
	}

	return activityTime > cutoffTime
}

function isoWeekKey(timestamp: string, fallback: string): string {
	const time = parseTimestamp(timestamp)
	if (time === null) {
		return `unknown-${fallback}`
	}

	const date = new Date(time)
	const day = date.getUTCDay() || 7
	date.setUTCDate(date.getUTCDate() + 4 - day)

	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function releaseThreadsToKeep(threads: NotificationThread[], config: Config): Set<string> {
	const keepsWeeklyReleases = config.rules.some(
		rule => rule.subjectTypes.length === 1 && rule.subjectTypes[0] === 'Release' && rule.releaseRetention !== undefined
	)

	if (!keepsWeeklyReleases) {
		return new Set()
	}

	const latestByRepositoryAndWeek = new Map<string, NotificationThread>()
	for (const thread of threads) {
		if (thread.subject.type !== 'Release') {
			continue
		}

		const key = `${thread.repository.full_name}\u0000${isoWeekKey(thread.updated_at, thread.id)}`
		const current = latestByRepositoryAndWeek.get(key)
		if (current === undefined || (parseTimestamp(thread.updated_at) ?? -Infinity) > (parseTimestamp(current.updated_at) ?? -Infinity)) {
			latestByRepositoryAndWeek.set(key, thread)
		}
	}

	return new Set([...latestByRepositoryAndWeek.values()].map(thread => thread.id))
}

function resolveThreadAuthors(authors: string[] | undefined, viewer: string): string[] | undefined {
	return authors?.map(author => (author === '@me' ? viewer : author))
}

function applicableRules(config: Config, subjectType: SubjectType, threadAuthor: string | null, viewer: string): Rule[] {
	return config.rules.filter(rule => {
		if (!rule.subjectTypes.includes(subjectType)) {
			return false
		}

		const authors = resolveThreadAuthors(rule.threadAuthors, viewer)
		return authors === undefined || (threadAuthor !== null && authors.includes(threadAuthor))
	})
}

function extractIssueNumber(subjectUrl: string): string {
	const url = new URL(subjectUrl)
	if (url.origin !== API_BASE_URL) {
		throw new Error('Subject URL uses an unexpected API host')
	}

	const segments = url.pathname.split('/').filter(Boolean)
	const issueNumber = segments.at(-1)

	if (!issueNumber || !/^\d+$/.test(issueNumber)) {
		throw new Error('Subject URL does not contain an issue number')
	}

	return issueNumber
}

function repositoryPath(fullName: string): string {
	const [owner, repository, ...rest] = fullName.split('/')
	if (!owner || !repository || rest.length > 0) {
		throw new Error('Notification repository name is invalid')
	}

	return `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
}

function activityFrom(resource: CommentResource): Activity {
	return {
		author: actorLogin(resource.user),
		timestamp: activityTimestamp(resource)
	}
}

function stateChangeFrom(event: TimelineEvent): StateChange {
	return {
		author: actorLogin(event.actor),
		timestamp: event.created_at ?? null,
		event: event.event ?? null
	}
}

async function listActivities(
	client: ApiClient,
	thread: NotificationThread,
	subjectType: SubjectType,
	config: Config
): Promise<Activity[]> {
	if (thread.subject.url === null) {
		return []
	}

	const repository = repositoryPath(thread.repository.full_name)
	const issueNumber = extractIssueNumber(thread.subject.url)
	const since = thread.last_read_at === null ? '' : `&since=${encodeURIComponent(thread.last_read_at)}`
	const pagination = {
		maxPages: config.maxActivityPages,
		failOnTruncation: true
	}

	const issueComments = await client.paginate<CommentResource>(
		`/repos/${repository}/issues/${issueNumber}/comments?per_page=100${since}`,
		pagination
	)
	const activities = issueComments.map(activityFrom)

	if (subjectType === 'PullRequest') {
		const reviewComments = await client.paginate<CommentResource>(
			`/repos/${repository}/pulls/${issueNumber}/comments?per_page=100${since}`,
			pagination
		)
		const reviews = await client.paginate<CommentResource>(
			`/repos/${repository}/pulls/${issueNumber}/reviews?per_page=100`,
			pagination
		)

		activities.push(...reviewComments.map(activityFrom), ...reviews.map(activityFrom))
	}

	return activities.filter(activity => activityIsAfter(activity, thread.last_read_at))
}

async function listStateChanges(
	client: ApiClient,
	thread: NotificationThread,
	config: Config
): Promise<StateChange[]> {
	if (thread.subject.url === null) {
		return []
	}

	const repository = repositoryPath(thread.repository.full_name)
	const issueNumber = extractIssueNumber(thread.subject.url)
	const since = thread.last_read_at === null ? '' : `&since=${encodeURIComponent(thread.last_read_at)}`
	const events = await client.paginate<TimelineEvent>(
		`/repos/${repository}/issues/${issueNumber}/timeline?per_page=100${since}`,
		{
			maxPages: config.maxActivityPages,
			failOnTruncation: true
		}
	)

	return events
		.map(stateChangeFrom)
		.filter(stateChange => STATE_CHANGE_EVENTS.has(stateChange.event ?? '') && activityIsAfter(stateChange, thread.last_read_at))
}

export async function evaluateNotification(
	client: ApiClient,
	thread: NotificationThread,
	config: Config,
	viewerLogin: string,
	releaseThreadsToKeep: ReadonlySet<string> = new Set()
): Promise<Evaluation> {
	if (!SUBJECT_TYPES.includes(thread.subject.type as SubjectType)) {
		return { decision: 'skip', reason: 'unsupported-subject' }
	}

	const subjectType = thread.subject.type as SubjectType
	const viewer = normalizeLogin(viewerLogin)

	if (subjectType === 'Release') {
		const matchingRules = applicableRules(config, subjectType, null, viewer)
		if (matchingRules.length === 0) {
			return { decision: 'skip', reason: 'thread-outside-rule-scope' }
		}

		if (
			matchingRules.some(rule => rule.releaseRetention === 'latest-per-repository-per-week') &&
			releaseThreadsToKeep.has(thread.id)
		) {
			return { decision: 'skip', reason: 'release-retained-for-week' }
		}

		const currentThread = await client.request<NotificationThread>(
			`/notifications/threads/${encodeURIComponent(thread.id)}`
		)

		if (
			currentThread.updated_at !== thread.updated_at ||
			currentThread.subject.latest_comment_url !== thread.subject.latest_comment_url
		) {
			return { decision: 'skip', reason: 'thread-changed-during-check' }
		}

		return {
			decision: 'done',
			commentAuthor: 'release',
			matchedRules: matchingRules.map(rule => rule.name)
		}
	}

	if (thread.subject.url === null) {
		return { decision: 'skip', reason: 'missing-subject-link' }
	}

	const subject = await client.request<SubjectResource>(thread.subject.url)
	const threadAuthor = actorLogin(subject.user)
	if (threadAuthor === null) {
		return { decision: 'skip', reason: 'unknown-thread-author' }
	}

	const matchingRules = applicableRules(config, subjectType, threadAuthor, viewer)
	const stateChangeAuthors = new Set(
		matchingRules.flatMap(rule => resolveThreadAuthors(rule.stateChangeAuthors, viewer) ?? [])
	)
	if (stateChangeAuthors.size > 0) {
		const stateChanges = await listStateChanges(client, thread, config)
		const matchingStateChange = stateChanges.find(
			stateChange =>
				stateChange.author !== null &&
				stateChangeAuthors.has(stateChange.author) &&
				timestampsAreClose(thread.updated_at, stateChange.timestamp, config.notificationCommentSkewSeconds)
		)

		if (matchingStateChange) {
			const mutedAuthors = new Set([
				...matchingRules.flatMap(rule => rule.commentAuthors ?? []),
				...stateChangeAuthors
			])
			const activities = await listActivities(client, thread, subjectType, config)

			if (activities.some(activity => activity.author === null || !mutedAuthors.has(activity.author))) {
				return { decision: 'skip', reason: 'human-activity-after-last-read' }
			}

			const currentThread = await client.request<NotificationThread>(
				`/notifications/threads/${encodeURIComponent(thread.id)}`
			)

			if (
				currentThread.updated_at !== thread.updated_at ||
				currentThread.subject.latest_comment_url !== thread.subject.latest_comment_url
			) {
				return { decision: 'skip', reason: 'thread-changed-during-check' }
			}

			return {
				decision: 'done',
				commentAuthor: matchingStateChange.author,
				matchedRules: matchingRules.map(rule => rule.name)
			}
		}
	}

	if (thread.subject.latest_comment_url === null) {
		return { decision: 'skip', reason: 'missing-comment-link' }
	}

	const configuredCommentAuthors = new Set(config.rules.flatMap(rule => rule.commentAuthors ?? []))
	const latestComment = await client.request<CommentResource>(thread.subject.latest_comment_url)
	const latestCommentAuthor = actorLogin(latestComment.user)

	if (latestCommentAuthor === null || !configuredCommentAuthors.has(latestCommentAuthor)) {
		return { decision: 'skip', reason: 'comment-author-not-configured' }
	}

	if (!timestampsAreClose(thread.updated_at, activityTimestamp(latestComment), config.notificationCommentSkewSeconds)) {
		return { decision: 'skip', reason: 'comment-does-not-explain-update' }
	}

	const mutedAuthors = new Set(matchingRules.flatMap(rule => rule.commentAuthors ?? []))

	if (!mutedAuthors.has(latestCommentAuthor)) {
		return { decision: 'skip', reason: 'thread-outside-rule-scope' }
	}

	const activities = await listActivities(client, thread, subjectType, config)
	activities.push(activityFrom(latestComment))

	if (activities.some(activity => activity.author === null || !mutedAuthors.has(activity.author))) {
		return { decision: 'skip', reason: 'human-activity-after-last-read' }
	}

	const currentThread = await client.request<NotificationThread>(
		`/notifications/threads/${encodeURIComponent(thread.id)}`
	)

	if (
		currentThread.updated_at !== thread.updated_at ||
		currentThread.subject.latest_comment_url !== thread.subject.latest_comment_url
	) {
		return { decision: 'skip', reason: 'thread-changed-during-check' }
	}

	return {
		decision: 'done',
		commentAuthor: latestCommentAuthor,
		matchedRules: matchingRules.map(rule => rule.name)
	}
}

function apiUrl(endpoint: string): URL {
	const url = new URL(endpoint, API_BASE_URL)
	if (url.origin !== API_BASE_URL) {
		throw new Error('API endpoint uses an unexpected host')
	}

	return url
}

function nextLink(linkHeader: string | null): string | null {
	if (linkHeader === null) {
		return null
	}

	for (const link of linkHeader.split(',')) {
		const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/)
		if (match?.[2] === 'next') {
			return match[1] ?? null
		}
	}

	return null
}

export class GitHubClient implements ApiClient {
	readonly #token: string

	constructor(token: string) {
		if (token.trim() === '') {
			throw new Error('NOTIFICATIONS_TOKEN is empty')
		}

		this.#token = token
	}

	async #fetch(endpoint: string, method: 'GET' | 'DELETE'): Promise<Response> {
		const response = await fetch(apiUrl(endpoint), {
			method,
			signal: AbortSignal.timeout(30_000),
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${this.#token}`,
				'User-Agent': 'hyldmo-notification-janitor',
				'X-GitHub-Api-Version': API_VERSION
			}
		})

		if (!response.ok) {
			throw new Error(`GitHub API request failed with status ${response.status}`)
		}

		return response
	}

	async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.#fetch(endpoint, options.method ?? 'GET')

		if (response.status === 204) {
			return undefined as T
		}

		return (await response.json()) as T
	}

	async paginate<T>(endpoint: string, options: PaginationOptions = {}): Promise<T[]> {
		const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY
		const maxPages = options.maxPages ?? 100
		const items: T[] = []
		let page = 0
		let currentEndpoint: string | null = endpoint

		while (currentEndpoint !== null && items.length < maxItems) {
			if (page >= maxPages) {
				if (options.failOnTruncation) {
					throw new Error('GitHub API pagination exceeded the safety limit')
				}
				break
			}

			const response = await this.#fetch(currentEndpoint, 'GET')
			const pageItems = (await response.json()) as T[]
			if (!Array.isArray(pageItems)) {
				throw new Error('GitHub API returned an invalid paginated response')
			}

			items.push(...pageItems.slice(0, maxItems - items.length))
			currentEndpoint = nextLink(response.headers.get('link'))
			page += 1
		}

		return items
	}
}

function privateThreadReference(threadId: string): string {
	return createHash('sha256').update(threadId).digest('hex').slice(0, 12)
}

function increment(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1)
}

async function processWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let nextIndex = 0
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex]
			nextIndex += 1

			if (item !== undefined) {
				await worker(item)
			}
		}
	})

	await Promise.all(workers)
}

async function writeStepSummary(summary: RunSummary): Promise<void> {
	const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY
	if (!stepSummaryPath) {
		return
	}

	const lines = [
		'## Notification janitor',
		'',
		`- Mode: ${summary.dryRun ? 'dry run' : 'apply'}`,
		`- Notifications scanned: ${summary.scanned}`,
		`- Matching notifications: ${summary.candidates}`,
		`- Notifications marked Done: ${summary.completed}`,
		`- Errors: ${summary.errors}`,
		''
	]

	await appendFile(stepSummaryPath, `${lines.join('\n')}\n`, 'utf8')
}

export async function runJanitor(client: ApiClient, config: Config, now = new Date()): Promise<RunSummary> {
	const viewer = await client.request<Viewer>('/user')
	const viewerLogin = requireString(viewer.login, 'Authenticated user login')
	const since = new Date(now.getTime() - config.notificationLookbackHours * 3_600_000).toISOString()
	const threads = await client.paginate<NotificationThread>(
		`/notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`,
		{
			maxItems: config.maxNotifications
		}
	)
	const summary: RunSummary = {
		scanned: threads.length,
		candidates: 0,
		completed: 0,
		errors: 0,
		dryRun: config.dryRun,
		skipped: new Map()
	}
	const releaseThreadIdsToKeep = releaseThreadsToKeep(threads, config)

	await processWithConcurrency(threads, config.concurrency, async thread => {
		try {
			const evaluation = await evaluateNotification(client, thread, config, viewerLogin, releaseThreadIdsToKeep)

			if (evaluation.decision === 'skip') {
				increment(summary.skipped, evaluation.reason)
				return
			}

			summary.candidates += 1
			const reference = privateThreadReference(thread.id)

			if (config.dryRun) {
				console.log(`DRY RUN: would mark notification ${reference} Done after ${evaluation.commentAuthor} activity`)
				return
			}

			await client.request<void>(`/notifications/threads/${encodeURIComponent(thread.id)}`, { method: 'DELETE' })
			summary.completed += 1
			console.log(`Marked notification ${reference} Done after ${evaluation.commentAuthor} activity`)
		} catch (error) {
			summary.errors += 1
			const reference = privateThreadReference(thread.id)
			const message = error instanceof Error ? error.message : 'Unknown error'
			console.error(`Preserved notification ${reference}: ${message}`)
		}
	})

	console.log(
		`Scanned ${summary.scanned}; matched ${summary.candidates}; completed ${summary.completed}; errors ${summary.errors}`
	)

	for (const [reason, count] of [...summary.skipped.entries()].sort()) {
		console.log(`Skipped ${count}: ${reason}`)
	}

	await writeStepSummary(summary)
	return summary
}

export function parseCliOptions(args: string[]): CliOptions {
	let configPath = DEFAULT_CONFIG_PATH
	let dryRunOverride: boolean | undefined
	let help = false

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]

		if (argument === '--config') {
			const value = args[index + 1]
			if (!value) {
				throw new Error('--config requires a path')
			}
			configPath = value
			index += 1
			continue
		}

		if (argument === '--dry-run') {
			if (dryRunOverride === false) {
				throw new Error('--dry-run and --apply cannot be combined')
			}
			dryRunOverride = true
			continue
		}

		if (argument === '--apply') {
			if (dryRunOverride === true) {
				throw new Error('--dry-run and --apply cannot be combined')
			}
			dryRunOverride = false
			continue
		}

		if (argument === '--help' || argument === '-h') {
			help = true
			continue
		}

		throw new Error(`Unknown argument: ${argument}`)
	}

	return { configPath, dryRunOverride, help }
}

function printHelp(): void {
	console.log(`Usage: notification-janitor.ts [options]

Options:
  --config <path>  Configuration file path
  --dry-run        Inspect and report without changing notifications
  --apply          Mark matching notifications Done
  -h, --help       Show this help`)
}

async function main(): Promise<void> {
	const options = parseCliOptions(process.argv.slice(2))
	if (options.help) {
		printHelp()
		return
	}

	const token = process.env.NOTIFICATIONS_TOKEN ?? process.env.GH_TOKEN
	if (!token) {
		throw new Error('NOTIFICATIONS_TOKEN is required')
	}

	const configText = await readFile(resolve(options.configPath), 'utf8')
	const config = validateConfig(JSON.parse(configText) as unknown)
	if (options.dryRunOverride !== undefined) {
		config.dryRun = options.dryRunOverride
	}

	const summary = await runJanitor(new GitHubClient(token), config)
	if (summary.errors > 0) {
		process.exitCode = 1
	}
}

const mainModuleUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null

if (mainModuleUrl === import.meta.url) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : 'Unknown error'
		console.error(`Notification janitor failed: ${message}`)
		process.exitCode = 1
	})
}
