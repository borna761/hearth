<script lang="ts">
	// No submit button — PINs are a fixed 4 digits (DESIGN.md §13), so the parent
	// auto-submits the moment the 4th digit lands. Nothing here needs to know that; it
	// just reports each tap.
	let {
		value,
		onDigit,
		onBackspace,
		disabled = false
	}: {
		value: string;
		onDigit: (digit: string) => void;
		onBackspace: () => void;
		disabled?: boolean;
	} = $props();

	const PIN_LENGTH = 4;
	const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
</script>

<div class="flex flex-col items-center gap-3">
	<!-- Dots, not digits — a PIN typed in a kitchen is already observable (DESIGN.md
	     §5.3's stated threat model), but there's no reason to make it easier by echoing it
	     as plain text on an 8" panel anyone walking by can read. -->
	<div class="flex h-6 gap-3" aria-label="PIN entered so far">
		{#each { length: PIN_LENGTH } as _, i (i)}
			<span
				class="h-3.5 w-3.5 rounded-full border-2 border-slate-400 dark:border-slate-500 {i <
				value.length
					? 'bg-slate-700 dark:bg-slate-300'
					: 'bg-transparent'}"
			></span>
		{/each}
	</div>

	<div class="grid grid-cols-3 gap-2">
		{#each DIGITS as digit (digit)}
			<button
				type="button"
				{disabled}
				onclick={() => onDigit(digit)}
				class="h-14 w-14 rounded-full bg-slate-100 text-xl font-medium text-slate-800 active:bg-slate-200 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-100 dark:active:bg-slate-600"
			>
				{digit}
			</button>
		{/each}
		<span></span>
		<button
			type="button"
			{disabled}
			onclick={() => onDigit('0')}
			class="h-14 w-14 rounded-full bg-slate-100 text-xl font-medium text-slate-800 active:bg-slate-200 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-100 dark:active:bg-slate-600"
		>
			0
		</button>
		<button
			type="button"
			{disabled}
			onclick={onBackspace}
			class="h-14 w-14 rounded-full bg-slate-100 text-base font-medium text-slate-600 active:bg-slate-200 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-300 dark:active:bg-slate-600"
			aria-label="Backspace"
		>
			⌫
		</button>
	</div>
</div>
