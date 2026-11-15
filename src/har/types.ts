// HTTP Archive 1.2 as browsers, Playwright and agents really write it: every field optional,
// numbers sometimes -1, plus the vendor fields (`_resourceType`, `_transferSize`, `_initiator`…).
// http://www.softwareishard.com/blog/har-12-spec/

export type HarNameValue = { name: string; value: string; comment?: string }

export type HarCookie = {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: string | null
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  comment?: string
}

export type HarPostParam = { name: string; value?: string; fileName?: string; contentType?: string }

export type HarPostData = {
  mimeType?: string
  text?: string
  params?: HarPostParam[]
  encoding?: string
  /** Playwright "attach" mode: the body is a file of the same .har.zip. */
  _file?: string
}

export type HarRequest = {
  method?: string
  url?: string
  httpVersion?: string
  cookies?: HarCookie[]
  headers?: HarNameValue[]
  queryString?: HarNameValue[]
  postData?: HarPostData
  headersSize?: number
  bodySize?: number
  comment?: string
}

export type HarContent = {
  size?: number
  compression?: number
  mimeType?: string
  text?: string
  encoding?: string
  comment?: string
  _file?: string
}

export type HarResponse = {
  status?: number
  statusText?: string
  httpVersion?: string
  cookies?: HarCookie[]
  headers?: HarNameValue[]
  content?: HarContent
  redirectURL?: string
  headersSize?: number
  bodySize?: number
  _transferSize?: number
  _error?: string | null
  _failureText?: string
}

export type HarTimings = {
  blocked?: number
  dns?: number
  connect?: number
  send?: number
  wait?: number
  receive?: number
  ssl?: number
  _blocked_queueing?: number
  _blocked_proxy?: number
  comment?: string
}

export type HarCallFrame = {
  functionName?: string
  scriptId?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

export type HarStack = {
  description?: string
  callFrames?: HarCallFrame[]
  parent?: HarStack
}

export type HarInitiator = {
  type?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stack?: HarStack
  requestId?: string
}

export type HarWebSocketMessage = {
  type?: 'send' | 'receive' | string
  time?: number
  opcode?: number
  data?: string
}

export type HarEntry = {
  pageref?: string
  startedDateTime?: string
  time?: number
  request?: HarRequest
  response?: HarResponse
  cache?: Record<string, unknown>
  timings?: HarTimings
  serverIPAddress?: string
  connection?: string
  comment?: string
  _initiator?: HarInitiator | string
  _priority?: string | null
  _resourceType?: string
  _transferSize?: number
  _fromCache?: string | boolean
  _fromDiskCache?: boolean
  _fromServiceWorker?: boolean
  _serverPort?: number
  _securityState?: string
  _webSocketMessages?: HarWebSocketMessage[]
  _error?: string | null
  _wasFetchedViaServiceWorker?: boolean
}

export type HarPage = {
  startedDateTime?: string
  id?: string
  title?: string
  pageTimings?: { onContentLoad?: number; onLoad?: number; comment?: string }
  comment?: string
}

export type HarCreator = { name?: string; version?: string; comment?: string }

export type HarLog = {
  version?: string
  creator?: HarCreator
  browser?: HarCreator
  pages?: HarPage[]
  entries?: HarEntry[]
  comment?: string
}

export type Har = { log: HarLog }
