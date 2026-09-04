<script lang="ts">
	import { formatDayHeading } from '$lib/week/format';
	import type { NextEvent } from '$lib/week/nextEvent';
	import type { ViewMode } from '$lib/week/viewMode';
	import type { TasksSnapshot } from '$lib/server/tasks';

	let {
		today,
		nextEvent,
		viewMode,
		tasks,
		onToggleView,
		onOpenTasks,
		onLock
	}: {
		today: string;
		nextEvent: NextEvent | null;
		viewMode: ViewMode;
		tasks: TasksSnapshot | null;
		onToggleView: () => void;
		onOpenTasks: () => void;
		onLock: () => void;
	} = $props();
</script>

<header
	class="flex h-20 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 dark:border-slate-700 dark:bg-slate-900"
>
	<h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">
		{formatDayHeading(today)}
	</h1>

	<div class="flex items-center gap-4">
		{#if nextEvent}
			<p class="text-lg text-slate-600 dark:text-slate-300">
				<span class="text-slate-400 dark:text-slate-500">Next:</span>
				{nextEvent.event.title}
				<span class="text-slate-400 dark:text-slate-500">·</span>
				<!-- Bare "11:00" reads as today by default — only worth naming the day when it
				     isn't, e.g. an early-morning event still days off with nothing between now
				     and then. -->
				{#if nextEvent.day.date !== today}
					{nextEvent.day.weekday}
				{/if}
				{nextEvent.event.time}
			</p>
		{:else}
			<p class="text-lg text-slate-400 dark:text-slate-500">Nothing else this week</p>
		{/if}

		{#if tasks}
			<!-- Same "count, not a live list" shape as the groceries badge above — overdue +
			     due-today per Alex's spec, the list itself opens over the grid (TasksPanel). -->
			<button
				type="button"
				onclick={onOpenTasks}
				class="flex items-center gap-1.5 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
			>
				✅ {tasks.count}
			</button>
		{/if}

		<button
			type="button"
			onclick={onToggleView}
			class="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
		>
			{viewMode === 'agenda' ? 'Hours' : 'Agenda'}
		</button>

		<!-- The idle timeout (DESIGN.md §5) ends a session after two minutes automatically,
		     but there was no way to say "I'm done" before that — this is that button. -->
		<button
			type="button"
			onclick={onLock}
			aria-label="Lock"
			class="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
		>
			Lock
		</button>
	</div>
</header>
