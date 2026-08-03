/**
 * An existing chat, addressed by its url id.
 *
 * Ported from bolt.diy's app/routes/chat.$id.tsx, which re-exported the index
 * route and used a loader purely to surface `params.id` via `useLoaderData`.
 * Next exposes the dynamic segment through `useParams`, which is what
 * lib/persistence/useChatHistory.ts now reads — so this route renders exactly
 * the same component as the studio home and needs no data step of its own.
 */
export { default } from '../../page';
