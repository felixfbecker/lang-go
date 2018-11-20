export interface FullSettings {
    /**
     * The address to the Go language server listening for WebSocket connections.
     */
    'go.serverUrl': string
    /**
     * The key in settings where this extension looks to find the access token
     * for the current user.
     */
    'go.accessToken': string
    /**
     * Whether or not a second references provider for external references will be
     * registered (defaults to false).
     */
    'go.externalReferences': boolean
    /**
     * The maximum number of repositories to look in when searching for external
     * references for a symbol (defaults to 50).
     */
    'go.maxExternalReferenceRepos': number
    /**
     * When set, will cause this extension to use to use godoc.org's API
     * (https://github.com/golang/gddo) to find packages that import a given
     * package (used in finding external references). This cannot be set to
     * `https://godoc.org` because godoc.org does not set CORS headers. You'll
     * need a proxy such as https://github.com/sourcegraph/godocdotorg-proxy to
     * get around this.
     */
    'go.goDocDotOrgURL': string
}

export type Settings = Partial<FullSettings>
