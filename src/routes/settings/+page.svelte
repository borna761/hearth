<script lang="ts">
	import type { PageData } from './$types';
	import LoginForm from '$lib/components/settings/LoginForm.svelte';
	import CalendarVisibilitySection from '$lib/components/settings/CalendarVisibilitySection.svelte';
	import QuietHoursSection from '$lib/components/settings/QuietHoursSection.svelte';
	import MusicHoursSection from '$lib/components/settings/MusicHoursSection.svelte';
	import ThemeSection from '$lib/components/settings/ThemeSection.svelte';
	import TimeFormatSection from '$lib/components/settings/TimeFormatSection.svelte';
	import LocationSection from '$lib/components/settings/LocationSection.svelte';
	import TimeZoneSection from '$lib/components/settings/TimeZoneSection.svelte';
	import UserSettingsSection from '$lib/components/settings/UserSettingsSection.svelte';
	import AnyListSection from '$lib/components/settings/AnyListSection.svelte';
	import TodoistSection from '$lib/components/settings/TodoistSection.svelte';
	import TaskAccessSection from '$lib/components/settings/TaskAccessSection.svelte';
	import MusicSpeakersSection from '$lib/components/settings/MusicSpeakersSection.svelte';
	import ConnectionsSection from '$lib/components/settings/ConnectionsSection.svelte';

	let { data }: { data: PageData } = $props();

	// One shared toast for every section's save confirmation on this page, rather than each
	// section managing its own inline "Saved" state — a single fixed-position notice reads
	// more clearly than several scattered around a long settings page.
	let toastMessage = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function showToast(message: string) {
		toastMessage = message;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastMessage = null), 2000);
	}
</script>

<svelte:head><title>Settings — Hearth</title></svelte:head>

<main class="mx-auto max-w-3xl p-6 text-slate-900">
	<h1 class="mb-6 text-2xl font-semibold">Hearth settings</h1>

	{#if !data.authorized && data.reason === 'not-admin'}
		<p class="text-slate-600">This account can't access settings.</p>
	{:else if !data.authorized}
		<LoginForm adminUsers={data.adminUsers} />
	{:else}
		<CalendarVisibilitySection
			rows={data.rows}
			users={data.users}
			checked={data.checked}
			{showToast}
		/>
		<QuietHoursSection quietHoursValue={data.quietHoursValue} {showToast} />
		<MusicHoursSection musicHoursValue={data.musicHoursValue} {showToast} />
		<ThemeSection themeMode={data.themeMode} {showToast} />
		<TimeFormatSection timeFormat={data.timeFormat} {showToast} />
		<LocationSection locationValue={data.locationValue} {showToast} />
		<TimeZoneSection timeZone={data.timeZone} timeZoneOptions={data.timeZoneOptions} {showToast} />
		<UserSettingsSection users={data.users} />
		<AnyListSection />
		<TodoistSection />
		<TaskAccessSection
			users={data.users}
			taskProjects={data.taskProjects}
			restrictedTaskProjectId={data.restrictedTaskProjectId}
			{showToast}
		/>
		<MusicSpeakersSection musicSpeakers={data.musicSpeakers} />
		<ConnectionsSection connections={data.connections} />
	{/if}

	{#if toastMessage}
		<p
			class="fixed bottom-6 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg"
		>
			{toastMessage}
		</p>
	{/if}
</main>
