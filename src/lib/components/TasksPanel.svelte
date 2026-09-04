<script lang="ts">
	import type { TasksSnapshot, TaskItem } from '$lib/server/tasks';
	import { formatMonthDay } from '$lib/week/format';

	let {
		tasks,
		onClose,
		large = false
	}: {
		tasks: TasksSnapshot;
		onClose: () => void;
		/** Same reasoning as GroceryPanel's own `large` prop — Sam's simple view runs
		 *  everything else at ~1.6x the standard view's type. */
		large?: boolean;
	} = $props();

	let sizes = $derived(
		large
			? {
					width: 'w-[26rem]',
					headerHeight: 'h-20',
					title: 'text-2xl',
					subtitle: 'text-sm',
					stale: 'px-2.5 py-1 text-sm',
					closeBtn: 'h-12 w-12 text-2xl',
					sectionLabel: 'text-sm',
					emptyState: 'text-lg',
					itemRow: 'min-h-16',
					itemTitle: 'text-xl',
					itemMeta: 'text-base',
					checkbox: 'h-8 w-8',
					pendingDot: 'h-2.5 w-2.5'
				}
			: {
					width: 'w-96',
					headerHeight: 'h-16',
					title: 'text-lg',
					subtitle: 'text-xs',
					stale: 'px-2 py-0.5 text-xs',
					closeBtn: 'h-10 w-10 text-xl',
					sectionLabel: 'text-xs',
					emptyState: 'text-base',
					itemRow: 'min-h-14',
					itemTitle: 'text-base',
					itemMeta: 'text-sm',
					checkbox: 'h-6 w-6',
					pendingDot: 'h-2 w-2'
				}
	);

	// Per-task in-flight guard, same shape as GroceryPanel's own `busy` — no local
	// optimistic state here either, since the server's optimistic apply + SSE push
	// (buildTasksSnapshot excluding a just-checked row) is what updates the UI; this only
	// prevents a double-tap from firing two requests.
	let busy = $state<Record<string, boolean>>({});

	async function complete(task: TaskItem) {
		if (busy[task.id]) return;
		busy[task.id] = true;
		try {
			await fetch(`/api/tasks/${task.id}`, { method: 'POST' });
		} finally {
			delete busy[task.id];
		}
	}
</script>

{#snippet taskRow(task: TaskItem, showDueDate: boolean)}
	{@const meta = large
		? showDueDate
			? formatMonthDay(task.dueDate)
			: null
		: showDueDate
			? `${task.projectName} · ${formatMonthDay(task.dueDate)}`
			: task.projectName}
	<li>
		<button
			type="button"
			onclick={() => complete(task)}
			disabled={busy[task.id]}
			class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left disabled:opacity-50 dark:border-slate-800"
		>
			<span
				class="{sizes.checkbox} shrink-0 rounded-md border-2 border-slate-300 dark:border-slate-600"
			></span>
			{#if task.pending}
				<!-- Same amber pending mark GroceryPanel shows on an unsynced item — nothing
				     is ever lost, only delayed, and this is the visible reminder of that. -->
				<span
					class="{sizes.pendingDot} shrink-0 rounded-full bg-amber-400"
					aria-label="Not yet synced"
				></span>
			{/if}
			<span class="flex-1 truncate {sizes.itemTitle} text-slate-900 dark:text-slate-100">
				{task.title}
			</span>
			{#if meta}
				<span class="shrink-0 {sizes.itemMeta} text-slate-500 dark:text-slate-400">
					{meta}
				</span>
			{/if}
		</button>
	</li>
{/snippet}

<!-- Invisible tap-to-close target for everything outside the sidebar — same shell
     GroceryPanel uses, no dimming for the same reason (the dashboard stays visible behind
     it on purpose). -->
<button type="button" onclick={onClose} aria-label="Close tasks" class="absolute inset-0 z-10"
></button>

<!-- Translucent (bg-white/70), not blurred — DESIGN.md §2.4 rules out backdrop-filter/blur
     on this hardware, same reasoning Screensaver.svelte's own overlay already follows. -->
<div
	class="absolute inset-y-0 right-0 z-20 flex {sizes.width} flex-col border-l border-slate-200 bg-white/70 shadow-xl dark:border-slate-700 dark:bg-slate-900/70"
>
	<header
		class="flex {sizes.headerHeight} shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-700"
	>
		<div class="flex items-baseline gap-2.5">
			<h1 class="{sizes.title} font-semibold text-slate-900 dark:text-slate-100">Tasks</h1>
			<p class="{sizes.subtitle} text-slate-500 dark:text-slate-400">
				{tasks.count} due
			</p>
			{#if tasks.stale}
				<!-- Same DESIGN.md §2.5 stale badge groceries shows for an AnyList outage. -->
				<span
					class="rounded bg-amber-100 {sizes.stale} font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
				>
					Can't reach Todoist right now
				</span>
			{/if}
		</div>
		<button
			type="button"
			onclick={onClose}
			aria-label="Done"
			class="flex {sizes.closeBtn} items-center justify-center rounded-full text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
		>
			✕
		</button>
	</header>

	<div class="flex-1 overflow-y-auto px-3 py-2">
		{#if tasks.count === 0}
			<p class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
				Nothing overdue or due today.
			</p>
		{:else}
			{#if tasks.overdue.length > 0}
				<p
					class="mt-3 px-1 pt-2 {sizes.sectionLabel} font-medium tracking-wide text-slate-400 uppercase first:mt-0 dark:text-slate-500"
				>
					Overdue
				</p>
				<ul>
					{#each tasks.overdue as task (task.id)}
						{@render taskRow(task, true)}
					{/each}
				</ul>
			{/if}
			{#if tasks.dueToday.length > 0}
				<p
					class="mt-3 px-1 pt-2 {sizes.sectionLabel} font-medium tracking-wide text-slate-400 uppercase first:mt-0 dark:text-slate-500"
				>
					Due today
				</p>
				<ul>
					{#each tasks.dueToday as task (task.id)}
						{@render taskRow(task, false)}
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>
