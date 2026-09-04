<script lang="ts">
	import type { SnapshotDay } from '$lib/server/state/snapshot';
	import { layoutHourColumn, minutesToRangePercent } from '$lib/week/hourLayout';
	import { formatMinutes, formatMinutesRange, type TimeFormat } from '$lib/week/format';

	let {
		days,
		nowMinutes,
		displayHours,
		timeFormat
	}: {
		days: SnapshotDay[];
		nowMinutes: number;
		displayHours: { start: number; end: number };
		timeFormat: TimeFormat;
	} = $props();

	// No need to show 22:00–07:00: the screen is off then anyway (DESIGN.md §9.2 quiet
	// hours). Events outside this range still render — clamped to the edge, never hidden —
	// in case something genuinely starts or ends outside typical waking hours. Comes from
	// the snapshot rather than a hardcoded copy, so it can never drift from the same
	// quiet-hours setting the server uses to decide when to stop pushing state at all.
	const HOUR_START = $derived(displayHours.start);
	const HOUR_END = $derived(displayHours.end);
	// One label per hour, matching the hourly background gridlines drawn below — labelling
	// only every third one (an earlier version of this) left most gridlines unidentifiable
	// without counting.
	const HOUR_LABELS = $derived(
		Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) =>
			formatMinutes((HOUR_START + i) * 60, timeFormat)
		)
	);

	function nowLineTop(minutes: number): number {
		return minutesToRangePercent(minutes, HOUR_START, HOUR_END);
	}

	function dayNumber(date: string): string {
		return String(Number(date.slice(8, 10)));
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<!-- Day headers + all-day chips, as one shared CSS grid row across all seven columns —
	     not stacked inside each day's own flex column. A grid row stretches every cell to
	     the tallest one automatically, so a day with five all-day events and a day with
	     none still end this row at the exact same height. Without that, each day's hour
	     grid below started at a different Y offset — the shared hour-label gutter assumes
	     one consistent start, so the "07:00" gridline in one column landed at a visibly
	     different pixel than in the next. A border-bottom alone (an earlier attempt at this
	     fix) made the boundary look cleaner without fixing that underlying misalignment. -->
	<div class="flex shrink-0 border-b border-slate-200 dark:border-slate-700">
		<!-- Empty spacer matching the hour gutter's width below (w-9) — without it, this
		     row's 7 columns divide the FULL width while the hour-grid row's 7 columns divide
		     (full width minus the gutter), so every day boundary lands at a different X
		     between the two rows even though each row is internally consistent. -->
		<div class="w-9 shrink-0 border-r border-slate-200 dark:border-slate-700"></div>
		<div class="grid flex-1 grid-cols-7">
			{#each days as day (day.date)}
				{@const allDayEvents = day.events.filter((e) => e.allDay)}
				<div
					class="flex flex-col border-r border-slate-200 last:border-r-0 dark:border-slate-700 {day.isToday
						? 'bg-blue-50/60 dark:bg-blue-900/20'
						: day.weekday === 'Sat' || day.weekday === 'Sun'
							? 'bg-slate-100/30 dark:bg-slate-400/10'
							: ''}"
				>
					<header class="flex items-baseline gap-1.5 px-2 pt-2 pb-1">
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

					{#if allDayEvents.length > 0}
						<div class="space-y-0.5 px-1.5 pb-1.5">
							{#each allDayEvents as event (event.id)}
								<div
									class="truncate rounded border-l-[3px] px-1.5 py-0.5 text-xs font-medium text-slate-800 dark:text-slate-200"
									style="border-left-color: {event.color ??
										'#94a3b8'}; background-color: {event.color ?? '#94a3b8'}1a;"
								>
									{event.title}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		<!-- Hour gutter: one shared label column rather than repeating labels per day, which
		     would multiply DOM nodes sevenfold for no added information (§2.4). -->
		<div class="relative w-9 shrink-0 border-r border-slate-200 dark:border-slate-700">
			{#each HOUR_LABELS as label, i (label)}
				<span
					class="absolute -translate-y-1/2 text-[10px] text-slate-400 dark:text-slate-500"
					style="top: {(i / (HOUR_LABELS.length - 1)) * 100}%"
				>
					{label}
				</span>
			{/each}
		</div>

		<div class="grid min-h-0 flex-1 grid-cols-7">
			{#each days as day (day.date)}
				{@const timedEvents = day.events.filter((e) => !e.allDay)}
				<div
					class="relative min-h-0 overflow-hidden border-r border-slate-200 last:border-r-0 dark:border-slate-700 {day.isToday
						? 'bg-blue-50/60 dark:bg-blue-900/20'
						: day.weekday === 'Sat' || day.weekday === 'Sun'
							? 'bg-slate-100/30 dark:bg-slate-400/10'
							: ''}"
				>
					<!-- Hour gridlines as a background, not seven columns' worth of extra DOM
					     nodes (§2.4). The line color is a CSS variable, not a class per se, so it
					     can flip with the dark: variant while still feeding the inline gradient
					     the JS-computed stop percentages need. -->
					<div
						class="absolute inset-0 [--hourgrid-line:#f1f5f9] dark:[--hourgrid-line:#1e293b]"
						style="background-image: repeating-linear-gradient(to bottom, transparent, transparent calc({100 /
							(HOUR_END - HOUR_START)}% - 1px), var(--hourgrid-line) calc({100 /
							(HOUR_END - HOUR_START)}% - 1px), var(--hourgrid-line) calc({100 /
							(HOUR_END - HOUR_START)}%));"
					></div>

					{#if day.isToday && nowMinutes >= HOUR_START * 60 && nowMinutes <= HOUR_END * 60}
						<div
							class="absolute right-0 left-0 z-10 h-px bg-red-500"
							style="top: {nowLineTop(nowMinutes)}%"
						>
							<span class="absolute -top-[3px] -left-[3px] h-[7px] w-[7px] rounded-full bg-red-500"
							></span>
						</div>
					{/if}

					{#each layoutHourColumn(timedEvents, HOUR_START, HOUR_END) as block (block.event.id)}
						<div
							class="absolute right-0.5 left-0.5 overflow-hidden rounded border-l-[3px] px-1 py-px text-[11px] leading-tight text-slate-800 dark:text-slate-200"
							style="top: {block.top}%; height: {block.height}%;
								border-left-color: {block.event.color ?? '#94a3b8'}; background-color: {block.event.color ??
								'#94a3b8'}22;"
						>
							<div class="truncate font-medium">{block.event.title}</div>
							{#if block.event.startMinutes !== null && block.event.endMinutes !== null}
								<div class="truncate text-slate-500 dark:text-slate-400">
									{formatMinutesRange(block.event.startMinutes, block.event.endMinutes, timeFormat)}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>
