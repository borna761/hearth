<script lang="ts">
	import type { WeekSnapshot } from '$lib/server/state/snapshot';
	import { buildSimpleViewModel } from '$lib/week/simpleView';
	import type { TimeFormat } from '$lib/week/format';
	import type { TasksSnapshot } from '$lib/server/tasks';

	// DESIGN.md §5.2: same WeekSnapshot data as everyone else, a different presentation —
	// not a separate code path.
	let {
		snapshot,
		nowMinutes,
		timeFormat,
		tasks,
		onLock,
		onOpenTasks
	}: {
		snapshot: WeekSnapshot;
		nowMinutes: number;
		timeFormat: TimeFormat;
		tasks: TasksSnapshot | null;
		onLock: () => void;
		onOpenTasks: () => void;
	} = $props();

	let model = $derived(buildSimpleViewModel(snapshot, nowMinutes, timeFormat));
</script>

<div class="flex h-full flex-col gap-6 overflow-y-auto p-8 text-slate-900 dark:text-slate-100">
	<header class="flex items-start justify-between">
		<div>
			<h1 class="text-6xl font-bold">{model.weekday}</h1>
			<p class="text-3xl text-slate-500 dark:text-slate-400">{model.monthDay}</p>
		</div>
		<!-- DESIGN.md §5.2: touch targets are at least 56px in this view — larger than the
		     standard view's small text button, to match everything else here. -->
		<button
			type="button"
			onclick={onLock}
			aria-label="Lock"
			class="flex h-14 items-center rounded-full border border-slate-300 px-5 text-lg font-medium text-slate-500 active:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:active:bg-slate-800"
		>
			Lock
		</button>
	</header>

	{#if model.nextUp}
		<section
			class="flex min-h-[30vh] flex-col justify-center gap-2 rounded-2xl border-l-8 p-6"
			style="border-left-color: {model.nextUp.color ?? '#94a3b8'}; background-color: {model.nextUp
				.color ?? '#94a3b8'}1a;"
		>
			<p class="text-xl font-medium text-slate-500 uppercase dark:text-slate-400">Next up</p>
			<p class="text-5xl font-bold">{model.nextUp.title}</p>
			<p class="text-3xl text-slate-600 dark:text-slate-300">
				{model.nextUp.time} · {model.nextUp.relative}
			</p>
		</section>

		{#if model.restOfToday.length > 0}
			<section class="flex flex-col gap-2">
				{#each model.restOfToday as event, i (i)}
					<div
						class="flex min-h-16 items-center gap-4 rounded-lg bg-slate-50 px-4 dark:bg-slate-800"
					>
						<span
							class="h-4 w-4 shrink-0 rounded-full"
							style="background-color: {event.color ?? '#94a3b8'}"
						></span>
						<span class="text-xl text-slate-500 tabular-nums dark:text-slate-400">{event.time}</span
						>
						<span class="text-2xl font-medium">{event.title}</span>
					</div>
				{/each}
			</section>
		{/if}
	{:else}
		<p class="text-3xl text-slate-400 dark:text-slate-500">Nothing scheduled today.</p>
		{#if model.nextLine}
			<p class="text-2xl text-slate-400 dark:text-slate-500">{model.nextLine}</p>
		{/if}
	{/if}

	<div class="mt-auto flex flex-col gap-4">
		{#if model.tomorrowLine}
			<p class="text-xl text-slate-400 dark:text-slate-500">{model.tomorrowLine}</p>
		{/if}

		{#if tasks}
			<!-- §5.2 item 5: full-width at the bottom, opening the same panel everyone else
			     uses — not a separate write path for them. Same surface color as the "rest of
			     today" rows above, rather than a standalone inverted CTA — it used to swap to
			     a dark bar in light mode and a light bar in dark mode, which read as ignoring
			     the theme rather than following it. -->
			<button
				type="button"
				onclick={onOpenTasks}
				class="flex h-16 items-center justify-center gap-2 rounded-2xl bg-slate-50 text-2xl font-semibold active:bg-slate-200 dark:bg-slate-800 dark:active:bg-slate-700"
			>
				✅ Tasks · {tasks.count}
			</button>
		{/if}
	</div>
</div>
