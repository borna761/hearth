<script lang="ts">
	import type { TasksSnapshot, TaskItem } from '$lib/server/tasks';
	import { formatMonthDay } from '$lib/week/format';
	import { panelSizes } from '$lib/panelSizes';
	import SidebarPanel from './SidebarPanel.svelte';
	import PanelHeader from './PanelHeader.svelte';
	import PendingDot from './PendingDot.svelte';

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
					...panelSizes(true),
					subtitle: 'text-sm',
					stale: 'px-2.5 py-1 text-sm',
					sectionLabel: 'text-sm',
					itemMeta: 'text-base',
					checkbox: 'h-8 w-8',
					pendingDot: 'h-2.5 w-2.5'
				}
			: {
					...panelSizes(false),
					subtitle: 'text-xs',
					stale: 'px-2 py-0.5 text-xs',
					sectionLabel: 'text-xs',
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
				<PendingDot class={sizes.pendingDot} />
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

<SidebarPanel {onClose} closeLabel="Close tasks" width={sizes.width}>
	<PanelHeader
		title="Tasks"
		subtitle="{tasks.count} due"
		staleMessage={tasks.stale ? "Can't reach Todoist right now" : null}
		{onClose}
		{sizes}
	/>

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
</SidebarPanel>
