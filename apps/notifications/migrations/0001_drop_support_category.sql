-- Drops the `support` category's notifications now that the ticket system is gone.
--
-- Support is plain email to soporte@franciscosolis.cl, handled in a Google Group, so nothing
-- publishes `support.*` events any more and `src/lib/catalog.ts` no longer knows how to render them.
-- A row this Worker cannot word would sit in somebody's bell forever with no link that works, so it
-- goes. `recipients.category_preferences` needs no rewrite: it is parsed against `CATEGORIES`, which
-- ignores a key it does not list, and the next save writes it back without one.
--
-- Hand-written data, no DDL, so it is not listed in `migrations/meta/_journal.json`.
DELETE FROM `notifications` WHERE `category` = 'support';
