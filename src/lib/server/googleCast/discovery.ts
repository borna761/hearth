// Resolves a configured speaker/group's current host by its Cast "friendly name" — see
// docs/phase-7-music-plan.md for why this can't just be a stored IP: a speaker group's
// connectable address is anchored to whichever member device currently leads it, which
// can shift, so this re-resolves via mDNS on every play rather than trusting a cache.

import Bonjour from 'bonjour-service';

const DEFAULT_TIMEOUT_MS = 5000;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface DiscoveredCastDevice {
	host: string;
	port: number;
}

interface DiscoveredService {
	txt?: Record<string, string>;
	addresses?: string[];
	port: number;
}

interface BrowserLike {
	on(event: 'up', listener: (service: DiscoveredService) => void): void;
	stop(): void;
}

function defaultCreateBrowser(): BrowserLike {
	const bonjour = new Bonjour();
	const browser = bonjour.find({ type: 'googlecast', protocol: 'tcp' });
	return {
		on: (event, listener) => browser.on(event, listener),
		stop: () => {
			browser.stop();
			bonjour.destroy();
		}
	};
}

/** A device can advertise both an IPv4 and IPv6 address — prefer IPv4, since that's what
 *  the rest of this app's LAN addressing already assumes. */
function pickAddress(addresses: string[] | undefined): string | null {
	if (!addresses || addresses.length === 0) return null;
	return addresses.find((addr) => IPV4_PATTERN.test(addr)) ?? addresses[0];
}

/** Lists every distinct Cast friendly name seen during a fixed scan window — the
 *  settings screen's "Scan for speakers" action, so the household picks from what's
 *  actually discoverable (individual speakers and groups alike) rather than typing a
 *  name blind. */
export async function discoverAllSpeakerNames(
	options: { timeoutMs?: number; createBrowser?: () => BrowserLike } = {}
): Promise<string[]> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, createBrowser = defaultCreateBrowser } = options;
	const browser = createBrowser();
	const names = new Set<string>();

	browser.on('up', (service) => {
		if (service.txt?.fn) names.add(service.txt.fn);
	});

	return new Promise((resolve) => {
		setTimeout(() => {
			browser.stop();
			resolve([...names].sort());
		}, timeoutMs);
	});
}

export async function resolveSpeakerHost(
	castName: string,
	options: { timeoutMs?: number; createBrowser?: () => BrowserLike } = {}
): Promise<DiscoveredCastDevice | null> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, createBrowser = defaultCreateBrowser } = options;
	const browser = createBrowser();

	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: DiscoveredCastDevice | null) => {
			if (settled) return;
			settled = true;
			browser.stop();
			resolve(result);
		};

		browser.on('up', (service) => {
			if (service.txt?.fn !== castName) return;
			const host = pickAddress(service.addresses);
			if (host === null) return;
			finish({ host, port: service.port });
		});

		setTimeout(() => finish(null), timeoutMs);
	});
}
