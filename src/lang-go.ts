import * as wsrpc from '@sourcegraph/vscode-ws-jsonrpc'
import * as sourcegraph from 'sourcegraph'
import { Location, Position, Range } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as convert from './convert-lsp-to-sea'

import {
    BehaviorSubject,
    combineLatest,
    EMPTY,
    from,
    Observable,
    Observer,
    of,
    Subject,
    Subscribable,
    Subscription,
    throwError,
    Unsubscribable,
} from 'rxjs'
import { distinct, distinctUntilChanged, map, share, shareReplay, switchMap, take } from 'rxjs/operators'
import * as langserverHTTP from 'sourcegraph-langserver-http/src/extension'

import gql from 'tagged-template-noop'
import { LANGSERVER_ADDRESS_SETTING, Settings } from './settings'

// The key in settings where this extension looks to find the access token for
// the current user.
const ACCESS_TOKEN_SETTING = 'go.accessToken'

/**
 * Returns a URL to Sourcegraph's raw API, given a repo, rev, and optional
 * token. When the token is not provided, the resulting URL will not be
 * authenticated.
 *
 * @param repoName looks like `github.com/gorilla/mux`
 * @param revision whatever Sourcegraph's raw API supports (40 char hash,
 * `master`, etc.)
 * @param token an authentication token for the current user
 */
function constructZipURL({
    repoName,
    revision,
    token,
}: {
    repoName: string
    revision: string
    token: string | undefined
}): string {
    const zipURL = new URL(sourcegraph.internal.sourcegraphURL.toString())
    zipURL.pathname = repoName + '@' + revision + '/-/raw'
    if (token) {
        zipURL.username = token
    }
    return zipURL.href
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

// Undefined means the current user is anonymous.
let accessTokenPromise: Promise<string | undefined>
export async function getOrTryToCreateAccessToken(): Promise<string | undefined> {
    const accessToken = sourcegraph.configuration.get().get(ACCESS_TOKEN_SETTING) as string | undefined
    if (accessToken) {
        return accessToken
    }
    if (accessTokenPromise) {
        return await accessTokenPromise
    }
    accessTokenPromise = tryToCreateAccessToken()
    return await accessTokenPromise
}

async function tryToCreateAccessToken(): Promise<string | undefined> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
    if (!currentUser) {
        return undefined
    } else {
        const currentUserId: string = currentUser.id
        const result = await queryGraphQL(
            gql`
                mutation CreateAccessToken($user: ID!, $scopes: [String!]!, $note: String!) {
                    createAccessToken(user: $user, scopes: $scopes, note: $note) {
                        id
                        token
                    }
                }
            `,
            { user: currentUserId, scopes: ['user:all'], note: 'lang-go' }
        )
        const token: string = result.createAccessToken.token
        await sourcegraph.configuration.get().update(ACCESS_TOKEN_SETTING, token)
        return token
    }
}

async function connectAndInitialize(address: string, root: URL): Promise<rpc.MessageConnection> {
    const connection = (await new Promise((resolve, reject) => {
        const webSocket = new WebSocket(address)
        const conn = rpc.createMessageConnection(
            new wsrpc.WebSocketMessageReader(wsrpc.toSocket(webSocket)),
            new wsrpc.WebSocketMessageWriter(wsrpc.toSocket(webSocket))
        )
        webSocket.addEventListener('open', () => resolve(conn))
        webSocket.addEventListener('error', reject)
    })) as rpc.MessageConnection

    connection.listen()

    await connection.sendRequest(
        new lsp.RequestType<
            lsp.InitializeParams & {
                originalRootUri: string
                rootPath: string
            },
            lsp.InitializeResult,
            lsp.InitializeError,
            void
        >('initialize') as any,
        {
            originalRootUri: root.href,
            rootUri: 'file:///',
            rootPath: '/',
            initializationOptions: {
                zipURL: constructZipURL({
                    repoName: root.pathname.replace(/^\/+/, ''),
                    revision: root.search.substr(1),
                    token: await getOrTryToCreateAccessToken(),
                }),
            },
        }
    )

    connection.sendNotification(lsp.InitializedNotification.type)

    return connection
}

type SendRequest = (doc: sourcegraph.TextDocument, requestType: any, request: any) => Promise<any>

/**
 * Creates a function of type SendRequest that can be used to send LSP
 * requests to the corresponding language server. This returns an Observable
 * so that all the connections to that language server can be disposed of
 * when calling .unsubscribe().
 *
 * Internally, this maintains a mapping from rootURI to the connection
 * associated with that rootURI, so it supports multiple roots (untested).
 */
function mkSendRequest(address: string): Observable<SendRequest> {
    function rootURIFromDoc(doc: sourcegraph.TextDocument): URL {
        const url = new URL(doc.uri)
        url.hash = ''
        return url
    }

    const rootURIToConnection: { [rootURI: string]: Promise<rpc.MessageConnection> } = {}
    function connectionFor(root: URL): Promise<rpc.MessageConnection> {
        if (rootURIToConnection[root.href]) {
            return rootURIToConnection[root.href]
        } else {
            rootURIToConnection[root.href] = connectAndInitialize(address, root)
            return rootURIToConnection[root.href]
        }
    }

    const sendRequest: SendRequest = async (doc, requestType, request) =>
        await (await connectionFor(rootURIFromDoc(doc))).sendRequest(requestType, request)

    return Observable.create((observer: Observer<SendRequest>) => {
        observer.next(sendRequest)
        return () => {
            for (const rootURI of Object.keys(rootURIToConnection)) {
                if (rootURIToConnection[rootURI]) {
                    rootURIToConnection[rootURI].then(connection => connection.dispose())
                    delete rootURIToConnection[rootURI]
                }
            }
        }
    })
}

/**
 * Uses WebSockets to communicate with a language server.
 */
export function activateUsingWebSockets(): void {
    const langserverAddress: BehaviorSubject<string | undefined> = new BehaviorSubject<string | undefined>(undefined)
    sourcegraph.configuration.subscribe(() => {
        langserverAddress.next(sourcegraph.configuration.get<Settings>().get(LANGSERVER_ADDRESS_SETTING))
    })

    const NO_ADDRESS_ERROR = `To get Go code intelligence, add "${LANGSERVER_ADDRESS_SETTING}": "wss://example.com" to your settings.`

    const sendRequestObservable = langserverAddress.pipe(
        switchMap(address => (address ? mkSendRequest(address) : of(undefined))),
        shareReplay(1)
    )

    function sendRequest(doc: sourcegraph.TextDocument, requestType: any, request: any): Promise<any> {
        return sendRequestObservable
            .pipe(
                take(1),
                switchMap(send => (send ? send(doc, requestType, request) : throwError(NO_ADDRESS_ERROR)))
            )
            .toPromise()
    }

    // TODO When go.langserver-address is set to an invalid address
    // and this extension fails to connect, the hover spinner hangs
    // indefinitely. @felix, could you take a look? I'm guessing the
    // error is not getting propagated, but despite 30 minutes of
    // debugging I can't figure out why.
    const sendDocPositionRequest = (doc: sourcegraph.TextDocument, pos: sourcegraph.Position, ty: any): Promise<any> =>
        sendRequest(doc, ty, {
            textDocument: {
                uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
            },
            position: {
                line: pos.line,
                character: pos.character,
            },
        })

    sourcegraph.languages.registerHoverProvider([{ pattern: '*.go' }], {
        provideHover: async (doc, pos) => {
            const response = await sendDocPositionRequest(doc, pos, lsp.HoverRequest.type)
            return convert.hover(response)
        },
    })

    sourcegraph.languages.registerDefinitionProvider([{ pattern: '*.go' }], {
        provideDefinition: async (doc, pos) => {
            const response = await sendDocPositionRequest(doc, pos, new lsp.RequestType<any, any, any, void>(
                'textDocument/xdefinition'
            ) as any)
            return convert.xdefinition({ currentDocURI: doc.uri, xdefinition: response })
        },
    })

    sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
        provideReferences: async (doc, pos) => {
            const response = await sendDocPositionRequest(doc, pos, lsp.ReferencesRequest.type)
            return convert.references({ currentDocURI: doc.uri, references: response })
        },
    })

    sourcegraph.languages.registerImplementationProvider([{ pattern: '*.go' }], {
        provideImplementation: async (doc, pos) => {
            const response = await sendDocPositionRequest(doc, pos, lsp.ImplementationRequest.type)
            return convert.references({ currentDocURI: doc.uri, references: response })
        },
    })
}

export function activateUsingLSPProxy(): void {
    langserverHTTP.activateWith({
        provideLSPResults: async (method, doc, pos) => {
            const docURL = new URL(doc.uri)
            const zipURL = constructZipURL({
                repoName: docURL.pathname.replace(/^\/+/, ''),
                revision: docURL.search.substr(1),
                token: await getOrTryToCreateAccessToken(),
            })
            return langserverHTTP.provideLSPResults(method, doc, pos, { zipURL })
        },
    })
}

export function activate(): void {
    console.log('activate')
    function afterActivate(): void {
        console.log('afteractivate')
        const address = sourcegraph.configuration.get<Settings>().get(LANGSERVER_ADDRESS_SETTING)
        if (address) {
            console.log('Detected langserver address', address, 'using WebSockets to communicate with it.')
            activateUsingWebSockets()
        } else {
            // We can remove the LSP proxy implementation once all customers
            // with Go code intelligence have spun up their own language server
            // (post Sourcegraph 3).
            console.log(
                `Did not detect a langserver address in the setting ${LANGSERVER_ADDRESS_SETTING}, falling back to using the LSP gateway.`
            )
            activateUsingLSPProxy()
        }
    }
    setTimeout(afterActivate, 0)
}
