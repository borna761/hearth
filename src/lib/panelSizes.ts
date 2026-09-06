// Shared by GroceryPanel/TasksPanel/MusicPanel's own `sizes` — Sam's simple view
// (DESIGN.md §5.2) runs everything else at ~1.6x the standard view's type, and all three
// sidebar panels scale the same handful of dimensions for it. Each panel spreads this and
// adds only the sizing tokens specific to its own markup (a subtitle/stale badge, a
// checkbox, a cover image, ...).
export function panelSizes(large: boolean) {
	return large
		? {
				width: 'w-[26rem]',
				headerHeight: 'h-20',
				title: 'text-2xl',
				closeBtn: 'h-12 w-12 text-2xl',
				emptyState: 'text-lg',
				itemRow: 'min-h-16',
				itemTitle: 'text-xl'
			}
		: {
				width: 'w-96',
				headerHeight: 'h-16',
				title: 'text-lg',
				closeBtn: 'h-10 w-10 text-xl',
				emptyState: 'text-base',
				itemRow: 'min-h-14',
				itemTitle: 'text-base'
			};
}
