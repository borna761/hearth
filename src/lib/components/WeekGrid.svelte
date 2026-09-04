<script lang="ts">
	import type { SnapshotDay } from '$lib/server/state/snapshot';

	let { days }: { days: SnapshotDay[] } = $props();

	function dayNumber(date: string): string {
		return String(Number(date.slice(8, 10)));
	}
</script>

<div class="grid min-h-0 flex-1 grid-cols-7">
	{#each days as day (day.date)}
		<section
			class="flex min-h-0 flex-col border-r border-slate-200 last:border-r-0 dark:border-slate-700 {day.isToday
				? 'bg-blue-50/60 dark:bg-blue-900/20'
				: day.weekday === 'Sat' || day.weekday === 'Sun'
					? 'bg-slate-100/70 dark:bg-slate-800/40'
					: ''}"
		>
			<header class="flex shrink-0 items-baseline gap-1.5 px-2 pt-2 pb-1">
				<span
					class="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400"
				>
					{day.weekday}
				</span>
				<span
					class="text-sm font-semibold {day.isToday
						? 'flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white'
						: 'text-slate-700 dark:text-slate-300'}"
				>
					{dayNumber(day.date)}
				</span>
			</header>

			<ol class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
				{#each day.events as event (event.id)}
					<li
						class="flex items-baseline gap-1 rounded border-l-[3px] px-1.5 py-1 text-sm leading-tight"
						style="border-left-color: {event.color ?? '#94a3b8'}; {event.allDay
							? `background-color: ${event.color ?? '#94a3b8'}1a;`
							: ''}"
					>
						{#if !event.allDay}
							<span class="shrink-0 text-xs text-slate-500 tabular-nums dark:text-slate-400"
								>{event.time}</span
							>
						{/if}
						<span
							class="truncate text-slate-800 dark:text-slate-200"
							class:font-medium={event.allDay}
						>
							{event.title}
						</span>
					</li>
				{:else}
					<li class="px-1.5 py-1 text-sm text-slate-300 dark:text-slate-600">—</li>
				{/each}
			</ol>
		</section>
	{/each}
</div>
