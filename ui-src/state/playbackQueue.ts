/** Queue membership and order belong to the surface that opened the viewer. */
export function snapshotQueue(slug: string, originatingSlugs: readonly string[]): string[] {
  const slugs = [...new Set(originatingSlugs)];
  return slugs.includes(slug) ? slugs : [slug, ...slugs];
}

/** Resolve fresh clip metadata without admitting new library items to a session. */
export function resolveQueue<T extends {slug: string}>(slugs: readonly string[], clips: readonly T[]): T[] {
  const bySlug = new Map(clips.map(clip => [clip.slug, clip]));
  return slugs.flatMap(slug => {
    const clip = bySlug.get(slug);
    return clip ? [clip] : [];
  });
}

export function renameInQueue(slugs: readonly string[], from: string, to: string): string[] {
  return [...new Set(slugs.map(slug => slug === from ? to : slug))];
}
