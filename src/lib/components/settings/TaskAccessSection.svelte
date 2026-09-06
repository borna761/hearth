<script lang="ts">
	import { untrack } from 'svelte';
	import type { PublicUser, TaskAccess } from '$lib/server/users';
	import type { TodoistProjectOption } from '$lib/server/todoist/projects';

	let {
		users,
		taskProjects,
		restrictedTaskProjectId: initialRestrictedTaskProjectId,
		showToast
	}: {
		/** saveTaskAccess below mutates `user.taskAccess` on an entry of this array in place,
		 *  not through a callback — so this must be the actual reactive array the route's
		 *  `load()` returned (passed straight through by +page.svelte), the same requirement
		 *  CalendarVisibilitySection's `checked` prop documents for the same reason. */
		users: PublicUser[];
		taskProjects: TodoistProjectOption[];
		restrictedTaskProjectId: string | null;
		showToast: (message: string) => void;
	} = $props();

	// Re-seeded the same way the other sections' single-value settings are — see
	// QuietHoursSection's own comment for why.
	let restrictedTaskProjectId = $state<string | null>(null);
	$effect(() => {
		untrack(() => {
			restrictedTaskProjectId = initialRestrictedTaskProjectId;
		});
	});
	let savingRestrictedProject = $state(false);
	let restrictedProjectError = $state<string | null>(null);

	async function saveRestrictedProject(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		const previous = restrictedTaskProjectId;
		restrictedTaskProjectId = value;
		savingRestrictedProject = true;
		restrictedProjectError = null;
		try {
			const res = await fetch('/api/settings/task-restricted-project', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ projectId: value })
			});
			if (!res.ok) {
				restrictedTaskProjectId = previous;
				restrictedProjectError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingRestrictedProject = false;
		}
	}

	// Auto-saves per user, same reasoning as the visibility matrix's toggle().
	let savingTaskAccessUserId = $state<number | null>(null);
	let taskAccessError = $state<string | null>(null);

	async function saveTaskAccess(userId: number, event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value as TaskAccess;
		const user = users.find((u) => u.id === userId);
		const previous = user?.taskAccess;
		if (user) user.taskAccess = value; // optimistic
		savingTaskAccessUserId = userId;
		taskAccessError = null;
		try {
			const res = await fetch('/api/settings/task-access', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId, taskAccess: value })
			});
			if (!res.ok) {
				if (user && previous) user.taskAccess = previous; // revert
				taskAccessError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTaskAccessUserId = null;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Task access</h2>
	<p class="mb-4 text-sm text-slate-500">
		Which Todoist tasks each person sees, relative to one restricted project.
	</p>

	{#if taskProjects.length === 0}
		<p class="text-slate-400">No Todoist projects discovered yet.</p>
	{:else}
		<label class="mb-4 flex max-w-sm flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Restricted project</span>
			<select
				value={restrictedTaskProjectId ?? ''}
				onchange={saveRestrictedProject}
				disabled={savingRestrictedProject}
				class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
			>
				<option value="" disabled>Choose a project…</option>
				{#each taskProjects as project (project.projectId)}
					<option value={project.projectId}>{project.label}</option>
				{/each}
			</select>
			{#if restrictedProjectError}
				<p class="text-sm text-red-600">{restrictedProjectError}</p>
			{/if}
		</label>

		<ul class="flex flex-col gap-2">
			{#each users as user (user.id)}
				<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2">
					<span
						class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white"
						style="background-color: {user.color}"
					>
						{user.name[0]}
					</span>
					<span class="text-sm font-medium">{user.name}</span>
					<select
						value={user.taskAccess}
						onchange={(e) => saveTaskAccess(user.id, e)}
						disabled={savingTaskAccessUserId === user.id}
						class="ml-auto rounded border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-40"
					>
						<option value="all-but-one">All except the restricted project</option>
						<option value="only-one">Only the restricted project</option>
						<option value="none">No tasks</option>
					</select>
				</li>
			{/each}
		</ul>
		{#if taskAccessError}
			<p class="mt-2 text-sm text-red-600">{taskAccessError}</p>
		{/if}
	{/if}
</section>
