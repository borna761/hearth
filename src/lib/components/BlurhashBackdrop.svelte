<script lang="ts">
	import { decode } from 'blurhash';

	// DESIGN.md §7.1: "Each half letterboxes against its own blurred backdrop, expanded
	// from the blurhash already on the row." A portrait derivative sized with 'inside' fit
	// doesn't always exactly fill its 640x800 half — the aspect ratio is preserved, not
	// cropped — so this fills the gap instead of plain black bars.
	let { hash, class: className = '' }: { hash: string; class?: string } = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();

	// Small and cheap on purpose — blurhash is already a heavily-compressed, inherently
	// blurry representation; decoding at a low resolution and letting CSS scale it up is
	// both faster and looks identical to decoding at a higher one.
	const SIZE = 32;

	// Blurhash is a low-frequency color average, and averaging a busy photo tends to land
	// on a muddy, washed-out gray rather than anything that reads as intentional. Darkening
	// the decoded pixels here — plain array math on a 32x32 buffer, not a CSS filter (ruled
	// out on this hardware, DESIGN.md §2.4) — turns that into a deep, receding tone that
	// sits behind the photo instead of competing with it.
	const DARKEN = 0.55;

	$effect(() => {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		try {
			const pixels = decode(hash, SIZE, SIZE);
			for (let i = 0; i < pixels.length; i += 4) {
				pixels[i] *= DARKEN;
				pixels[i + 1] *= DARKEN;
				pixels[i + 2] *= DARKEN;
			}
			const imageData = ctx.createImageData(SIZE, SIZE);
			imageData.data.set(pixels);
			ctx.putImageData(imageData, 0, 0);
		} catch {
			// A malformed blurhash string shouldn't take the screensaver down — just no
			// backdrop for this one photo.
		}
	});
</script>

<canvas bind:this={canvasEl} width={SIZE} height={SIZE} class={className}></canvas>
