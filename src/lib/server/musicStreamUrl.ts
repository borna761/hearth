// The play endpoint normally builds each track's stream URL from the triggering request's
// own origin — correct in production, where that's the same real LAN-reachable hostname
// (e.g. http://hearth.local:8080) the tablet already uses to reach Hearth. That breaks
// when testing from the same machine running the dev server via `localhost`: "localhost"
// means "myself" to the Chromecast device, not the host serving it, so a queueLoad
// succeeds but the device silently fails to fetch the track. HEARTH_STREAM_BASE_URL lets
// local dev override just the stream base, without requiring the browser itself to stop
// using localhost.
export function resolveStreamBaseUrl(requestOrigin: string, override: string | undefined): string {
	return override || requestOrigin;
}
