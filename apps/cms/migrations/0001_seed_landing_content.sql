-- Seeds the landing page's own content into the CMS.
--
-- Hand-written like the auth Worker's `0001_seed.sql`, and for the same reason: it carries no DDL,
-- only idempotent INSERTs, so it is deliberately absent from `migrations/meta/_journal.json` and the
-- drizzle snapshot stays an accurate picture of the schema. `INSERT OR IGNORE` leans on the
-- `(collection, slug)` and `legal_pages.slug` unique indexes, so re-applying it is a no-op and an
-- entry an editor has since rewritten is never overwritten.
--
-- Every string below is the copy franciscosolis.cl already renders, taken from the site's own
-- sources: `src/pages/home/components/projects/projects.data.ts` and the `projects`, `experience`,
-- `stack` and `legal` translation namespaces. Three things about that mapping are worth knowing:
--
--   * The site's copy is bilingual and `content_entries` has no locale column, so what is seeded is
--     the English text. Serving the Spanish version is a schema change, not a row.
--   * The site's timeline only ever states years ("2020 — 2023"), so `started_at` / `ended_at` are
--     the 1st of January and the 31st of December of those years. The year is the fact; the day is
--     a placeholder for a column that needs one.
--   * `skills` carries no `level` or `years_of_experience`: the site publishes neither, and a
--     self-assessment nobody made is worse than an absent field.
--
-- Every value here is also what the admin API would have accepted through `POST /admin/content/…`:
-- the `data` blobs match the strict schemas in `src/lib/collections.ts` and the text fields stay
-- inside the limits in `src/routes/admin/`. A row that failed either would be a row an editor could
-- open in the CMS and never save again.


INSERT OR IGNORE INTO `content_entries` (`id`, `collection`, `slug`, `title`, `subtitle`, `summary`, `body`, `status`, `featured`, `position`, `started_at`, `ended_at`, `url`, `image_url`, `tags`, `data`, `published_at`, `created_by`, `updated_by`, `created_at`, `updated_at`) VALUES
  ('09ffdc47-f8c1-436a-91a7-a2c62bda42e8', 'projects', 'mi-utem', 'Mi UTEM', 'Mobile App', 'The official app of Universidad Tecnológica Metropolitana for its students.', 'Mobile app for UTEM students: timetables, grades, attendance and the digital student card in one place. I have worked on it since 2023 as part of the Experimental Development Club (ExDev), building new features in Flutter and automating App Store and Google Play releases with Fastlane and CI/CD.', 'published', 1, 0, 1672531200, NULL, 'https://github.com/exdevutem/mi-utem', NULL, '["mobile","apis"]', '{"role":"Mobile developer","client":"Experimental Development Club (ExDev), UTEM","technologies":["Flutter","Dart","Firebase","Fastlane","Kotlin","Swift","CI/CD"],"repository_url":"https://github.com/exdevutem/mi-utem","highlights":["Timetables, grades, attendance and the digital student card in one app.","New features built in Flutter for the university''s official student app.","App Store and Google Play releases automated with Fastlane and CI/CD."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('81079dc8-6b4f-4097-a81b-85d5b13118c7', 'projects', 'oktobeer', 'OKTOBEER', 'Landing Page', 'Landing page for a pub in Calama, Chile.', 'A single-page site showing the menu, location and contact details of a pub in Calama. Built with Next.js and Tailwind CSS, tuned to load fast on mobile and to let the owner update the menu without touching any code.', 'published', 1, 1, NULL, NULL, 'https://oktobeer.franciscosolis.cl', NULL, '["landing","frontend"]', '{"client":"OKTOBEER","technologies":["Next.js","React","TypeScript","Tailwind CSS","Vercel"],"demo_url":"https://oktobeer.franciscosolis.cl","highlights":["One page with the menu, the location and the contact details.","Tuned to load fast on mobile.","The owner updates the menu without touching any code."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3c107ddc-eaea-459b-bc4a-2d10b0d0f659', 'projects', 'portfolio', 'franciscosolis.cl', 'Web App', 'This very site: portfolio, my own auth service and CMS on Cloudflare.', 'My personal portfolio, rewritten on React 19 and Vite with a backend of my own in Hono.dev running on Cloudflare Workers. It ships ES/EN internationalisation, an accessibility centre with a command palette, and a custom CMS backed by D1 and R2 to manage projects and content without redeploying.', 'published', 1, 2, NULL, NULL, 'https://github.com/Im-Fran/franciscosolis.cl', NULL, '["webapp","frontend","backend","apis","cloud"]', '{"role":"Designer and developer","technologies":["React","TypeScript","Vite.js","Tailwind CSS","Hono.dev","Cloudflare Workers","D1","R2"],"repository_url":"https://github.com/Im-Fran/franciscosolis.cl","demo_url":"https://franciscosolis.cl","highlights":["React 19 and Vite on the front, Hono.dev on Cloudflare Workers behind it.","ES/EN internationalisation and an accessibility centre with a command palette.","A CMS of its own on D1 and R2, so content changes without a redeploy."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('9fbd5f02-f859-415e-a0ab-5952bb511046', 'projects', 'craftaro', 'Craftaro Marketplace', 'API & Backend', 'A plugin and extension marketplace, built from the ground up.', 'I led the development of a full marketplace from scratch: catalogue, seller accounts, licensing and downloads. Laravel backend with PostgreSQL and Redis, React and Tailwind CSS on the front, payments and payouts wired through Stripe, plus the Linux server infrastructure, continuous deployment and REST APIs holding it together.', 'published', 1, 3, 1672531200, 1735603200, 'https://craftaro.com', NULL, '["api","backend","apis","sysadmin","frontend"]', '{"role":"Lead developer","client":"Craftaro LLC","technologies":["Laravel","React","Tailwind CSS","PostgreSQL","Redis","Stripe","REST APIs"],"demo_url":"https://craftaro.com","highlights":["Catalogue, seller accounts, licensing and downloads, from scratch.","Payments and payouts wired through Stripe.","Linux server infrastructure, continuous deployment and the REST APIs holding it together."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('26f04213-dda8-4900-ab08-6714836ff23b', 'projects', 'rubybox', 'RubyBox', NULL, 'Inventory management and business dashboard.', NULL, 'published', 0, 4, NULL, NULL, 'https://github.com/Im-Fran/rubybox.cl', NULL, '[]', '{"repository_url":"https://github.com/Im-Fran/rubybox.cl"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('7624b291-897a-4d44-b5e2-a2d1d7b5f55c', 'projects', 'sonatype-central-upload', 'SonatypeCentralUpload', NULL, 'Gradle plugin for publishing artifacts to Sonatype Central.', NULL, 'published', 0, 5, NULL, NULL, 'https://github.com/Im-Fran/SonatypeCentralUpload', NULL, '[]', '{"technologies":["Gradle"],"repository_url":"https://github.com/Im-Fran/SonatypeCentralUpload"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('227db6b3-4229-4b93-89d5-1fedf58a3c6e', 'experience', 'self-taught-beginnings', 'Self-taught from scratch', NULL, 'I started coding out of curiosity, exploring open-source projects and learning Java and Kotlin without fear of getting it wrong.', NULL, 'published', 0, 0, NULL, NULL, NULL, NULL, '["beginnings"]', '{"position":"Self-taught developer","technologies":["Java","Kotlin"],"achievements":["Started coding out of curiosity, exploring open-source projects.","Learned Java and Kotlin without fear of getting it wrong."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('c72c52f4-3df8-4293-9a1a-041fcb37b071', 'experience', 'songoda', 'From support to technical lead', 'Songoda LLC', 'I started out leading community moderation and ended up directing marketplace development: Laravel, Vue and React over PostgreSQL and Redis, continuous integration and deployment, and the administration of the Linux servers holding the platform up.', NULL, 'published', 0, 1, 1577836800, 1703980800, NULL, NULL, '["backend","frontend","sysadmin"]', '{"company":"Songoda LLC","position":"Technical Lead","technologies":["Laravel","Vue.js","React","PostgreSQL","Redis","CI/CD","Linux"],"achievements":["Started out leading community moderation and ended up directing marketplace development.","Built the marketplace with Laravel, Vue and React over PostgreSQL and Redis.","Owned continuous integration and deployment.","Administered the Linux servers holding the platform up."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('062e4716-5eab-412f-bc0e-2ad96bf9bd48', 'experience', 'craftaro-llc', 'A marketplace from scratch', 'Craftaro LLC', 'I led the planning and development of a brand-new marketplace with Laravel, React and Tailwind CSS. I owned the Stripe integration, the infrastructure behind the associated platforms, and the tuning of the PostgreSQL and Redis databases.', NULL, 'published', 0, 2, 1672531200, 1735603200, NULL, NULL, '["backend","frontend","apis"]', '{"company":"Craftaro LLC","position":"Lead Developer","company_url":"https://craftaro.com","technologies":["Laravel","React","Tailwind CSS","Stripe","PostgreSQL","Redis"],"achievements":["Led the planning and development of a brand-new marketplace.","Owned the Stripe integration.","Ran the infrastructure behind the associated platforms.","Tuned the PostgreSQL and Redis databases."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('d74feaba-dcca-4f70-a528-943fabc72281', 'experience', 'exdev-club', 'From member to lead', 'ExDev Club · UTEM', 'I joined UTEM''s Experimental Development Club to work on the Mi UTEM app with Flutter, Fastlane and CI/CD, plus virtualisation projects with Proxmox and Active Directory. Since 2025 I lead the club and represent it at student fairs.', NULL, 'published', 0, 3, 1672531200, NULL, NULL, NULL, '["mobile","sysadmin"]', '{"company":"Experimental Development Club (ExDev), UTEM","position":"Club Lead","company_url":"https://github.com/exdevutem","technologies":["Flutter","Fastlane","CI/CD","Proxmox","Active Directory"],"achievements":["Joined to work on the Mi UTEM app with Flutter, Fastlane and CI/CD.","Took part in virtualisation projects with Proxmox and Active Directory.","Leads the club since 2025 and represents it at student fairs."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('c6f90c94-b6d7-4646-90bf-69091b7747c3', 'experience', 'inside-security', 'Infrastructure Protection', 'Inside Security', 'I administer operating systems, network services and cloud infrastructure under secure configurations, run monitoring to detect and respond to incidents, take part in digital forensics investigations, and work with development teams so what ships is secure.', NULL, 'published', 0, 4, 1735689600, NULL, NULL, NULL, '["security","sysadmin","cloud"]', '{"company":"Inside Security","position":"Infrastructure Protection","technologies":["Linux","Cloud Infrastructure","Security Monitoring","Incident Response","Digital Forensics","System Hardening"],"achievements":["Administers operating systems, network services and cloud infrastructure under secure configurations.","Runs monitoring to detect and respond to incidents.","Takes part in digital forensics investigations.","Works with development teams so what ships is secure."]}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('8d1b54fc-a5f0-4865-a355-8bcc532dc2b6', 'skills', 'frontend-react', 'React', NULL, NULL, NULL, 'published', 0, 0, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('e8017f2e-7357-4335-a76f-87d2596efff7', 'skills', 'frontend-next-js', 'Next.js', NULL, NULL, NULL, 'published', 0, 1, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('ee10c0d6-040d-40d2-9577-d4f1a9b193b6', 'skills', 'frontend-typescript', 'TypeScript', NULL, NULL, NULL, 'published', 0, 2, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('a1f1b384-0b90-4178-85b7-60cc08b6d885', 'skills', 'frontend-tailwind-css', 'Tailwind CSS', NULL, NULL, NULL, 'published', 0, 3, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('807c9208-3840-43d1-bb36-b5be8d3ca51b', 'skills', 'frontend-vite-js', 'Vite.js', NULL, NULL, NULL, 'published', 0, 4, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('fe79201a-5200-4b21-b249-64ce4918d28d', 'skills', 'frontend-javascript', 'JavaScript', NULL, NULL, NULL, 'published', 0, 5, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0823a099-9f2d-4c4b-a73a-0713f90f2909', 'skills', 'frontend-css', 'CSS', NULL, NULL, NULL, 'published', 0, 6, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0e8e446c-98aa-4eb1-a8ca-45fd9aa93b0a', 'skills', 'frontend-html5', 'HTML5', NULL, NULL, NULL, 'published', 0, 7, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('303aa896-a9b3-4e20-81c4-8c4c81f8b314', 'skills', 'frontend-cloudflare-pages', 'Cloudflare Pages', NULL, NULL, NULL, 'published', 0, 8, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('506534fd-4d1b-4fb9-b5e3-c14cfc5c90ad', 'skills', 'frontend-vue-js', 'Vue.js', NULL, NULL, NULL, 'published', 0, 9, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('dc52245e-3271-46d7-870f-e5314a2918ba', 'skills', 'frontend-nuxt', 'Nuxt', NULL, NULL, NULL, 'published', 0, 10, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('92e07938-85e7-495f-8690-f00629f73a4b', 'skills', 'frontend-sass', 'SASS', NULL, NULL, NULL, 'published', 0, 11, NULL, NULL, NULL, NULL, '["frontend"]', '{"category":"frontend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('117a3a9f-a579-4d0c-be56-84759d7a843e', 'skills', 'backend-node-js', 'Node.js', NULL, NULL, NULL, 'published', 0, 12, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('cc57f7ee-93d9-40aa-a6a3-689fcc3550ef', 'skills', 'backend-java', 'Java', NULL, NULL, NULL, 'published', 0, 13, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('5098f94f-068d-4271-90ef-715b39bf0f16', 'skills', 'backend-kotlin', 'Kotlin', NULL, NULL, NULL, 'published', 0, 14, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('d9f4c2dc-427c-44f3-bd21-823ee894628f', 'skills', 'backend-spring-boot', 'Spring Boot', NULL, NULL, NULL, 'published', 0, 15, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3c5f6fbd-7c66-40c5-9574-528c0c9cd441', 'skills', 'backend-laravel', 'Laravel', NULL, NULL, NULL, 'published', 0, 16, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0d235a55-2243-40eb-a819-0aad6dd17e5d', 'skills', 'backend-cloudflare-workers', 'Cloudflare Workers', NULL, NULL, NULL, 'published', 0, 17, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('a5e8ebc4-ecb0-4a0b-8d9b-747f58605873', 'skills', 'backend-bun-js', 'Bun.js', NULL, NULL, NULL, 'published', 0, 18, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('55339b39-8eaa-4e87-80e0-7422f3f0fb64', 'skills', 'backend-express-js', 'Express.js', NULL, NULL, NULL, 'published', 0, 19, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('ca00938f-1c08-4653-b58b-dbd81d596ea1', 'skills', 'backend-php', 'PHP', NULL, NULL, NULL, 'published', 0, 20, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('135b13d2-e58f-4e92-aa3c-1ddec7112451', 'skills', 'backend-hono-dev', 'Hono.dev', NULL, NULL, NULL, 'published', 0, 21, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3b0e16e7-24d6-4446-a39a-6aa3847400be', 'skills', 'backend-postgresql', 'PostgreSQL', NULL, NULL, NULL, 'published', 0, 22, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('5f3a5ddd-5040-41da-91bb-d707c1737db2', 'skills', 'backend-redis', 'Redis', NULL, NULL, NULL, 'published', 0, 23, NULL, NULL, NULL, NULL, '["backend"]', '{"category":"backend"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('86d8ef77-2977-4382-bc82-cb54d8c19804', 'skills', 'mobile-kotlin', 'Kotlin', NULL, NULL, NULL, 'published', 0, 24, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('34ff9996-b175-4b44-add9-43555b83aad0', 'skills', 'mobile-android', 'Android', NULL, NULL, NULL, 'published', 0, 25, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0c5d60f6-1425-4310-a752-49774ff9ab61', 'skills', 'mobile-react-native', 'React Native', NULL, NULL, NULL, 'published', 0, 26, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('84bc1dfe-4b13-4ecb-a553-b36886a32300', 'skills', 'mobile-flutter', 'Flutter', NULL, NULL, NULL, 'published', 0, 27, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0ea5d18a-c098-479e-973d-9ac0bd66a2cf', 'skills', 'mobile-flutter-libraries', 'Flutter Libraries', NULL, NULL, NULL, 'published', 0, 28, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('1b66bb79-686d-4ce1-84ab-c2e924a0e78e', 'skills', 'mobile-fastlane', 'Fastlane', NULL, NULL, NULL, 'published', 0, 29, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0d1d95cf-8285-48da-9161-656751d2b4c4', 'skills', 'mobile-xcode', 'Xcode', NULL, NULL, NULL, 'published', 0, 30, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('96e25cfe-f298-4c06-9a06-1ae8bb1e4f8c', 'skills', 'mobile-android-studio', 'Android Studio', NULL, NULL, NULL, 'published', 0, 31, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('342940a6-d415-4a57-b403-f3b498a15b56', 'skills', 'mobile-flutterfire', 'Flutterfire', NULL, NULL, NULL, 'published', 0, 32, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('e1137a4a-a889-4c9e-8534-388c016ae480', 'skills', 'mobile-firebase', 'Firebase', NULL, NULL, NULL, 'published', 0, 33, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('c837c327-f883-4960-9c8c-8f448c3dea72', 'skills', 'mobile-dart', 'Dart', NULL, NULL, NULL, 'published', 0, 34, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('2a2f08be-ccf9-49e7-b227-3b2160498fb7', 'skills', 'mobile-swift', 'Swift', NULL, NULL, NULL, 'published', 0, 35, NULL, NULL, NULL, NULL, '["mobile"]', '{"category":"mobile"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('237435da-5d1d-40c3-9cee-24503baa2502', 'skills', 'apis-rest-apis', 'REST APIs', NULL, NULL, NULL, 'published', 0, 36, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('01777dd2-741b-4a07-9de4-1822504b61a2', 'skills', 'apis-microservices', 'Microservices', NULL, NULL, NULL, 'published', 0, 37, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('1d9100b9-0ba1-481c-a276-954c303a33a5', 'skills', 'apis-docker', 'Docker', NULL, NULL, NULL, 'published', 0, 38, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('7efadd9f-a17a-47d8-9aec-b41829fb7a76', 'skills', 'apis-git', 'Git', NULL, NULL, NULL, 'published', 0, 39, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0af3dda2-6d82-4b19-a29e-94fa8b3faa04', 'skills', 'apis-stripe', 'Stripe', NULL, NULL, NULL, 'published', 0, 40, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('65221d9c-6546-4907-8ca6-7b0e317b9f99', 'skills', 'apis-ci-cd', 'CI/CD', NULL, NULL, NULL, 'published', 0, 41, NULL, NULL, NULL, NULL, '["apis"]', '{"category":"apis"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('683cf2c8-e7cd-47f9-93c6-9e3910c5a50e', 'skills', 'sysadmin-virtualization', 'Virtualization', NULL, NULL, NULL, 'published', 0, 42, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0f8dde81-52a3-443f-ac48-39f032663021', 'skills', 'sysadmin-proxmox', 'Proxmox', NULL, NULL, NULL, 'published', 0, 43, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('ee91ad33-37ad-454c-9369-cbae358484f5', 'skills', 'sysadmin-linux', 'Linux', NULL, NULL, NULL, 'published', 0, 44, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('cc837f24-025e-4e33-8105-8a56acd6fb9c', 'skills', 'sysadmin-red-hat-enterprise-linux', 'Red Hat Enterprise Linux', NULL, NULL, NULL, 'published', 0, 45, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('626200b8-bad1-488c-b710-b10f63cd5193', 'skills', 'sysadmin-ubuntu', 'Ubuntu', NULL, NULL, NULL, 'published', 0, 46, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('d247bbc3-afc1-4c21-b77e-09084af195ac', 'skills', 'sysadmin-debian', 'Debian', NULL, NULL, NULL, 'published', 0, 47, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('41306e66-8efb-4bd8-b38f-076a8765124e', 'skills', 'sysadmin-nginx', 'Nginx', NULL, NULL, NULL, 'published', 0, 48, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('5af5cf8b-631f-4870-b585-88a28c17c1bd', 'skills', 'sysadmin-windows-server', 'Windows Server', NULL, NULL, NULL, 'published', 0, 49, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('0de4cc2a-f7bf-4bd5-8eb7-85667299aeaa', 'skills', 'sysadmin-active-directory', 'Active Directory', NULL, NULL, NULL, 'published', 0, 50, NULL, NULL, NULL, NULL, '["sysadmin"]', '{"category":"sysadmin"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('e222723c-acfb-412d-91c4-69d68c97bbc0', 'skills', 'cloud-security-command-center', 'Security Command Center', 'Google Cloud Platform', NULL, NULL, 'published', 0, 51, NULL, NULL, NULL, NULL, '["cloud","google-cloud-platform"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('97c05cf5-f52b-42ae-9e7f-07534a16fbcd', 'skills', 'cloud-compute-engine', 'Compute Engine', 'Google Cloud Platform', NULL, NULL, 'published', 0, 52, NULL, NULL, NULL, NULL, '["cloud","google-cloud-platform"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('8e63bb76-7ffc-4870-bccf-a5d7cad894c3', 'skills', 'cloud-google-kubernetes-engine', 'Google Kubernetes Engine', 'Google Cloud Platform', NULL, NULL, 'published', 0, 53, NULL, NULL, NULL, NULL, '["cloud","google-cloud-platform"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('bb66ed9f-90b1-4330-9018-5530063cca23', 'skills', 'cloud-cloud-sql', 'Cloud SQL', 'Google Cloud Platform', NULL, NULL, 'published', 0, 54, NULL, NULL, NULL, NULL, '["cloud","google-cloud-platform"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('059ff833-2a2a-4d94-a986-902adbacb310', 'skills', 'cloud-cloud-storage', 'Cloud Storage', 'Google Cloud Platform', NULL, NULL, 'published', 0, 55, NULL, NULL, NULL, NULL, '["cloud","google-cloud-platform"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('2522fe9e-d33e-4c59-980f-6836f783a8c5', 'skills', 'cloud-cloud-guard', 'Cloud Guard', 'Oracle Cloud Infrastructure', NULL, NULL, 'published', 0, 56, NULL, NULL, NULL, NULL, '["cloud","oracle-cloud-infrastructure"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('6c5e7db8-f02d-4e0e-9e7d-acc700f72393', 'skills', 'cloud-vcn', 'VCN', 'Oracle Cloud Infrastructure', NULL, NULL, 'published', 0, 57, NULL, NULL, NULL, NULL, '["cloud","oracle-cloud-infrastructure"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('51415652-3478-4ea2-b515-1f333da38d15', 'skills', 'cloud-compute-instances', 'Compute Instances', 'Oracle Cloud Infrastructure', NULL, NULL, 'published', 0, 58, NULL, NULL, NULL, NULL, '["cloud","oracle-cloud-infrastructure"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('e634a18c-10ea-4a6d-9376-bfb5dc082b68', 'skills', 'cloud-r2', 'R2', 'Cloudflare Serverless', NULL, NULL, 'published', 0, 59, NULL, NULL, NULL, NULL, '["cloud","cloudflare-serverless"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('c97b09e0-0c52-4034-9297-f31081e31a1d', 'skills', 'cloud-d1', 'D1', 'Cloudflare Serverless', NULL, NULL, 'published', 0, 60, NULL, NULL, NULL, NULL, '["cloud","cloudflare-serverless"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('b15b36dc-6ce2-42cb-a8c6-ef995ff1ac7f', 'skills', 'cloud-workers', 'Workers', 'Cloudflare Serverless', NULL, NULL, 'published', 0, 61, NULL, NULL, NULL, NULL, '["cloud","cloudflare-serverless"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('322876d5-68fc-42c9-af8d-28d754c8c239', 'skills', 'cloud-pages', 'Pages', 'Cloudflare Serverless', NULL, NULL, 'published', 0, 62, NULL, NULL, NULL, NULL, '["cloud","cloudflare-serverless"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('d9785bdd-2a75-4bb1-91ae-b4301c510afd', 'skills', 'cloud-kv-namespaces', 'KV Namespaces', 'Cloudflare Serverless', NULL, NULL, 'published', 0, 63, NULL, NULL, NULL, NULL, '["cloud","cloudflare-serverless"]', '{"category":"cloud"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('9733b607-9bfc-4c62-88bc-b76ae98e3c98', 'skills', 'security-data-analysis', 'Data analysis', NULL, NULL, NULL, 'published', 0, 64, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('04a72807-7754-4022-bfe1-982893d3e4e7', 'skills', 'security-vulnerability-scanning', 'Vulnerability scanning', NULL, NULL, NULL, 'published', 0, 65, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('dcb27016-3bfa-4b72-a10e-22c7fe6e578a', 'skills', 'security-vulnerability-analysis', 'Vulnerability analysis', NULL, NULL, NULL, 'published', 0, 66, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('e3c44490-2735-4ceb-8155-08b3ed0a4b0a', 'skills', 'security-mitigation-plans', 'Mitigation plans', NULL, NULL, NULL, 'published', 0, 67, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('a2d228a3-005b-4e09-bfb4-74ebb8d62752', 'skills', 'security-system-updates', 'System updates', NULL, NULL, NULL, 'published', 0, 68, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3aa2415a-fd31-444d-ab0a-a3ed1018f797', 'skills', 'security-security-monitoring', 'Security monitoring', NULL, NULL, NULL, 'published', 0, 69, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('459b8d98-9c12-4989-83f5-1f67f5d9a9c0', 'skills', 'security-incident-response', 'Incident response', NULL, NULL, NULL, 'published', 0, 70, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3ecff1fd-d6ed-4646-87a1-a817da40ea12', 'skills', 'security-digital-forensics', 'Digital forensics', NULL, NULL, NULL, 'published', 0, 71, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('448b581a-6c21-45e4-8028-0a6a570b1a3d', 'skills', 'security-system-hardening', 'System hardening', NULL, NULL, NULL, 'published', 0, 72, NULL, NULL, NULL, NULL, '["security"]', '{"category":"security"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('78376c7c-f325-4d5b-855d-babe2cb8b3a4', 'skills', 'ai-chatgpt', 'ChatGPT', NULL, NULL, NULL, 'published', 0, 73, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('30fb5d03-9f2b-4b5b-b5db-02cef6d925e7', 'skills', 'ai-gemini', 'Gemini', NULL, NULL, NULL, 'published', 0, 74, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('973c223b-a124-439d-a563-cd15ca3af10c', 'skills', 'ai-claude', 'Claude', NULL, NULL, NULL, 'published', 0, 75, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('62cc7319-a5e7-400c-bdd7-54751e8f3ee7', 'skills', 'ai-claude-code', 'Claude Code', NULL, NULL, NULL, 'published', 0, 76, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('9f5161c0-983f-45bd-93eb-59037c1997d7', 'skills', 'ai-antigravity', 'Antigravity', NULL, NULL, NULL, 'published', 0, 77, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('8505e4f3-9f95-49e9-af72-3d7b39d0ddd0', 'skills', 'ai-ltx-2-3', 'LTX-2.3', NULL, NULL, NULL, 'published', 0, 78, NULL, NULL, NULL, NULL, '["ai"]', '{"category":"ai"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('9e81b545-c7ed-4e4a-a4f1-299a553de7a5', 'certifications', 'google-devfest-2024-challenge-lab', 'DevFest 2024 Challenge Lab', 'Google Developer Groups', 'Winner of the Google DevFest 2024 Challenge Lab, solved with BigQuery ML.', NULL, 'published', 0, 0, 1704067200, NULL, NULL, NULL, '["cloud","bigquery-ml"]', '{"issuer":"Google Developer Groups"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('3472f5d8-b6cf-4e55-a571-5e60bed13a16', 'certifications', 'github-foundations', 'GitHub Foundations', 'GitHub', 'GitHub Foundations certification, earned in 2024.', NULL, 'published', 0, 1, 1704067200, NULL, NULL, NULL, '["apis"]', '{"issuer":"GitHub"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('8c765044-6df5-4694-9156-b07f86b525cd', 'certifications', 'ef-set-english-c2', 'EF SET English Certificate (C2)', 'EF Education First', 'C2 English certified on the EF SET, with a score of 74/100.', NULL, 'published', 0, 2, 1704067200, NULL, NULL, NULL, '["languages"]', '{"issuer":"EF Education First"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('37c83f46-d807-4cbb-b3e0-fa4a34cdb043', 'education', 'computer-science-engineering-utem', 'Computer Science Engineering', 'Universidad Tecnológica Metropolitana', 'I study Computer Science Engineering at Universidad Tecnológica Metropolitana, in Santiago, alongside work. I was also part of the programme''s student council, in student relations.', NULL, 'published', 0, 0, 1640995200, NULL, 'https://www.utem.cl', NULL, '["university"]', '{"institution":"Universidad Tecnológica Metropolitana (UTEM)","degree":"Computer Science Engineering","field":"Computer Science","location":"Santiago, Chile","institution_url":"https://www.utem.cl"}', 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800);

INSERT OR IGNORE INTO `legal_pages` (`id`, `slug`, `title`, `summary`, `body`, `status`, `version`, `effective_at`, `published_at`, `created_by`, `updated_by`, `created_at`, `updated_at`) VALUES
  ('9e3d6ac1-9331-4f2e-a69d-413acff80d83', 'terms-of-service', 'Terms of Service', 'The terms that govern the use of franciscosolis.cl and the services behind it.', '## 1. Acceptance of Terms

By accessing or using this software and its services, you agree to be bound by these Terms of Service. If you do not agree with any part of these terms, you must not use the service.

## 2. Description of Service

The service is provided for informational, functional, or entertainment purposes as applicable, and may be modified, suspended, or discontinued at any time, in whole or in part, without prior notice.

## 3. License to Use

A limited, non-exclusive, non-transferable, and revocable license is granted to use the service in accordance with these terms. Redistribution, resale, or commercial exploitation without express authorization is prohibited.

## 4. User Conduct

The user agrees not to use the service for unlawful or fraudulent purposes, or in any way that could damage, overload, or compromise the security, integrity, or availability of the service or third parties.

## 5. Intellectual Property

All content, source code, design, trademarks, and other elements of the service are the property of their respective owners and are protected by applicable intellectual property laws. No rights are transferred to the user beyond the license of use described in these terms.

## 6. Service Provided "As Is" and Disclaimer of Warranties

This software and its services are provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, non-infringement, or that the service will be uninterrupted, timely, secure, or error-free.

## 7. Limitation of Liability

To the maximum extent permitted by law, no liability shall be assumed for any direct, indirect, incidental, special, or consequential damages arising from the use or inability to use the service, even if advised of the possibility of such damages.

## 8. Payments, Refunds, and Returns

If the service involves a payment, such payment shall be considered final. No claims, refunds, or returns will be accepted under any circumstance, unless otherwise expressly required by applicable law.

## 9. Termination of Service

Access to the service may be suspended or terminated, with or without cause and without prior notice, particularly in the event of a breach of these terms, without any right to compensation.

## 10. Changes to These Terms

These terms may be updated at any time. Continued use of the service after such changes are published constitutes acceptance of the new terms.

## 11. Governing Law and Jurisdiction

These terms are governed by the laws of the Republic of Chile. Any dispute arising from the use of the service will be submitted to the ordinary courts of justice of the city of Santiago de Chile, with any legal costs and expenses incurred to be borne by the user.

## 12. Severability

If any provision of these terms is found to be invalid or unenforceable, such provision will be limited or eliminated to the minimum extent necessary, and the remaining terms will continue in full force and effect.

## 13. Contact

For any inquiries related to these Terms of Service, you can write to fsolism@franciscosolis.cl.', 'published', '2026', 1767225600, 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800),
  ('558795dd-104c-48df-90f8-0a4b4fce909e', 'privacy-policy', 'Privacy Policy', 'What information the site collects, what it is used for, and how it is protected.', '## 1. Introduction

We take user privacy seriously. This Privacy Policy describes what information is collected, how it is used, and what measures are taken to protect it.

## 2. Data We Collect

We do not profile or store personally identifiable information about users unless the service explicitly requires it to function (for example, a contact form or authentication).

## 3. How We Use Data

When data is required, we only collect what is strictly necessary to provide the service, and it is used exclusively for that purpose, with no mass marketing or third-party sale.

## 4. Data Minimization and No Profiling

No user profiling or advertising-driven segmentation is performed. Data collection is limited to the minimum necessary for the service to function.

## 5. Cookies and Similar Technologies

The service may use cookies or similar technologies strictly necessary for its operation (for example, remembering language or interface preferences). No advertising tracking cookies are used.

## 6. Sharing Data with Third Parties

Collected data is not sold or shared with third parties, except when strictly necessary to operate the service (for example, infrastructure or email providers) or when required by law.

## 7. Information Security

Collected information is safeguarded with appropriate technical and organizational security measures, proportionate to the type of data and associated risk, aimed at preventing unauthorized access, loss, or alteration.

## 8. Data Retention

Data is retained only for as long as necessary to fulfill the purpose for which it was collected, unless a legal obligation requires a longer retention period.

## 9. User Rights

Users may request access, correction, or deletion of any personal data collected at any time by writing to fsolism@franciscosolis.cl.

## 10. Children

The service is not directed at minors, and we do not knowingly collect information from minors without parental or guardian consent.

## 11. Changes to This Policy

This Privacy Policy may be updated periodically. Material changes will be reflected in the "last updated" date shown on this page.

## 12. Contact

For any inquiries related to this Privacy Policy, you can write to fsolism@franciscosolis.cl.', 'published', '2026', 1767225600, 1787356800, 'fsolism@franciscosolis.cl', 'fsolism@franciscosolis.cl', 1787356800, 1787356800);
