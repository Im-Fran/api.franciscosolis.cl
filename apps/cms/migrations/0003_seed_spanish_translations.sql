-- Seeds the Spanish text of the landing page's content into `translations`.
--
-- Hand-written and, like `0001_seed_landing_content.sql`, deliberately absent from
-- `migrations/meta/_journal.json`: it carries no DDL, so the drizzle snapshot stays an accurate
-- picture of the schema. The column it fills is created by `0002_content_translations.sql`, which
-- is why this file sorts after it — Wrangler applies migrations in filename order.
--
-- Every string below is the Spanish copy franciscosolis.cl already renders, taken from the site's
-- own `src/translations/es/` namespaces. Four things about that mapping are worth knowing:
--
--   * The row keeps the English text and `translations` carries the override map, so what is
--     written here only ever *adds* a language. See `src/lib/locales.ts` for why the model is an
--     override map rather than a row per language.
--   * The site renders a timeline entry as one line ("Songoda LLC · From support to technical
--     lead") while the CMS splits it into `subtitle` and `title`. The Spanish is split the same
--     way, and an organisation name only gets an override where the Spanish copy spells it
--     differently ("Club ExDev").
--   * `skills` is almost entirely product names, which read the same in both languages. Only the
--     eleven the site actually translates are listed; an override repeating the English word is a
--     row that can only ever go stale.
--   * The three certifications have no Spanish copy on the site — it collapses them into a single
--     "Awards and certifications" milestone — so their summaries are translated from the English
--     the seed already wrote, and their issuers stay untranslated.
--
-- Each statement is guarded on `translations = '{}'` rather than being an unconditional UPDATE.
-- That makes re-applying the file a no-op and, more importantly, means a translation an editor has
-- since rewritten in the CMS is never silently reverted to this one.

-- Content entries, by collection and slug.
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Mi UTEM","subtitle":"Aplicación Móvil","summary":"La app oficial de la Universidad Tecnológica Metropolitana para sus estudiantes.","body":"App móvil para los estudiantes de la UTEM: horarios, notas, asistencia y credencial digital en un solo lugar. Trabajo en ella desde 2023 dentro del Club de Desarrollo Experimental (ExDev), desarrollando nuevas funcionalidades en Flutter y automatizando el despliegue a la App Store y Google Play con Fastlane y CI/CD."}}'
  WHERE `collection` = 'projects' AND `slug` = 'mi-utem' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"OKTOBEER","subtitle":"Landing Page","summary":"Landing page para un pub en Calama, Chile.","body":"Sitio de una sola página que muestra el menú, la ubicación y los datos de contacto de un pub en Calama. Construido con Next.js y Tailwind CSS, pensado para cargar rápido en móvil y para que el dueño pueda actualizar el menú sin tocar código."}}'
  WHERE `collection` = 'projects' AND `slug` = 'oktobeer' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"franciscosolis.cl","subtitle":"Web App","summary":"Este mismo sitio: portafolio, auth propio y CMS sobre Cloudflare.","body":"Mi portafolio personal, reescrito sobre React 19 y Vite con un backend propio en Hono.dev corriendo en Cloudflare Workers. Incluye internacionalización ES/EN, un centro de accesibilidad con paleta de comandos, y un CMS propio respaldado por D1 y R2 para administrar proyectos y contenido sin volver a desplegar."}}'
  WHERE `collection` = 'projects' AND `slug` = 'portfolio' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Marketplace Craftaro","subtitle":"API & Backend","summary":"Marketplace de plugins y extensiones, construido desde cero.","body":"Dirigí el desarrollo de un marketplace completo desde cero: catálogo, cuentas de vendedores, licencias y descargas. Backend en Laravel con PostgreSQL y Redis, frontend en React y Tailwind CSS, pagos y payouts integrados con Stripe, y la infraestructura de servidores Linux, despliegue continuo y APIs REST que lo sostienen."}}'
  WHERE `collection` = 'projects' AND `slug` = 'craftaro' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"RubyBox","summary":"Inventario y panel de control empresarial."}}'
  WHERE `collection` = 'projects' AND `slug` = 'rubybox' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"SonatypeCentralUpload","summary":"Plugin Gradle para publicar artefactos en Sonatype Central."}}'
  WHERE `collection` = 'projects' AND `slug` = 'sonatype-central-upload' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Autodidacta desde cero","summary":"Empecé programando por curiosidad, explorando proyectos abiertos y aprendiendo Java y Kotlin sin miedo a equivocarme."}}'
  WHERE `collection` = 'experience' AND `slug` = 'self-taught-beginnings' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Del soporte a la dirección técnica","summary":"Partí liderando la moderación de la comunidad y terminé dirigiendo el desarrollo del marketplace: Laravel, Vue y React sobre PostgreSQL y Redis, integración y despliegue continuo, y la administración de los servidores Linux que sostenían la plataforma."}}'
  WHERE `collection` = 'experience' AND `slug` = 'songoda' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Un marketplace desde cero","summary":"Dirigí la organización y el desarrollo de un marketplace nuevo con Laravel, React y Tailwind CSS. Me hice cargo de la integración con Stripe, de la infraestructura de las plataformas asociadas y de optimizar las bases de datos en PostgreSQL y Redis."}}'
  WHERE `collection` = 'experience' AND `slug` = 'craftaro-llc' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"De miembro a líder","subtitle":"Club ExDev · UTEM","summary":"Entré al Club de Desarrollo Experimental de la UTEM para trabajar en la app Mi UTEM con Flutter, Fastlane y CI/CD, además de proyectos de virtualización con Proxmox y Active Directory. Desde 2025 lidero el club y lo represento en ferias estudiantiles."}}'
  WHERE `collection` = 'experience' AND `slug` = 'exdev-club' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Protección de la Infraestructura","summary":"Administro sistemas operativos, servicios de red e infraestructura en la nube con configuraciones seguras, implemento monitoreo para detectar y responder a incidentes, colaboro en investigaciones forenses y trabajo con los equipos de desarrollo para que lo que se despliega sea seguro."}}'
  WHERE `collection` = 'experience' AND `slug` = 'inside-security' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Ingeniería Informática","summary":"Estudio Ingeniería Informática en la Universidad Tecnológica Metropolitana, en Santiago, mientras trabajo. Además fui parte del centro de estudiantes de la carrera, en el área de relaciones estudiantiles."}}'
  WHERE `collection` = 'education' AND `slug` = 'computer-science-engineering-utem' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"summary":"Ganador del Challenge Lab del Google DevFest 2024, resuelto con BigQuery ML."}}'
  WHERE `collection` = 'certifications' AND `slug` = 'google-devfest-2024-challenge-lab' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"summary":"Certificación GitHub Foundations, obtenida en 2024."}}'
  WHERE `collection` = 'certifications' AND `slug` = 'github-foundations' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Certificado de Inglés EF SET (C2)","summary":"Inglés C2 acreditado en el EF SET, con un puntaje de 74/100."}}'
  WHERE `collection` = 'certifications' AND `slug` = 'ef-set-english-c2' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Microservicios"}}'
  WHERE `collection` = 'skills' AND `slug` = 'apis-microservices' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Virtualización"}}'
  WHERE `collection` = 'skills' AND `slug` = 'sysadmin-virtualization' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Análisis de datos"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-data-analysis' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Escaneo de vulnerabilidades"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-vulnerability-scanning' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Análisis de vulnerabilidades"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-vulnerability-analysis' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Planes de mitigación"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-mitigation-plans' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Actualización de sistemas"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-system-updates' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Monitoreo de seguridad"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-security-monitoring' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Respuesta a incidentes"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-incident-response' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Forense digital"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-digital-forensics' AND `translations` = '{}';
UPDATE `content_entries` SET `translations` = '{"es":{"title":"Hardening de sistemas"}}'
  WHERE `collection` = 'skills' AND `slug` = 'security-system-hardening' AND `translations` = '{}';

-- Legal pages.
UPDATE `legal_pages` SET `translations` = '{"es":{"title":"Términos de Servicio","summary":"Los términos que rigen el uso de franciscosolis.cl y de los servicios que hay detrás.","body":"## 1. Aceptación de los Términos\n\nAl acceder o utilizar este software y sus servicios, aceptas quedar sujeto a estos Términos de Servicio. Si no estás de acuerdo con alguna parte de estos términos, no debes utilizar el servicio.\n\n## 2. Descripción del Servicio\n\nEl servicio se ofrece con fines informativos, funcionales o de entretenimiento según corresponda, y puede modificarse, suspenderse o discontinuarse en cualquier momento y sin previo aviso, total o parcialmente.\n\n## 3. Licencia de Uso\n\nSe otorga una licencia limitada, no exclusiva, intransferible y revocable para utilizar el servicio conforme a estos términos. Queda prohibida su redistribución, reventa o explotación comercial sin autorización expresa.\n\n## 4. Conducta del Usuario\n\nEl usuario se compromete a no utilizar el servicio con fines ilegales, fraudulentos, o que puedan dañar, sobrecargar o comprometer la seguridad, integridad o disponibilidad del servicio o de terceros.\n\n## 5. Propiedad Intelectual\n\nTodo el contenido, código fuente, diseño, marcas y demás elementos del servicio son propiedad de su autor o de sus respectivos titulares, y están protegidos por las leyes de propiedad intelectual aplicables. Ningún derecho se transfiere al usuario más allá de la licencia de uso descrita en estos términos.\n\n## 6. Servicio \"Tal Cual\" y Exclusión de Garantías\n\nEl software y sus servicios se entregan \"tal cual\" (as is) y \"según disponibilidad\", sin garantía de ningún tipo, expresa o implícita, incluyendo, entre otras, garantías de comerciabilidad, idoneidad para un propósito particular, no infracción, o de que el servicio será ininterrumpido, oportuno, seguro o libre de errores.\n\n## 7. Limitación de Responsabilidad\n\nEn la máxima medida permitida por la ley, no se asumirá responsabilidad alguna por daños directos, indirectos, incidentales, especiales o consecuentes derivados del uso o la imposibilidad de uso del servicio, incluso si se ha advertido de la posibilidad de dichos daños.\n\n## 8. Pagos, Reembolsos y Devoluciones\n\nEn caso de que el servicio contemple un pago, dicho pago se considerará final. No se aceptarán reclamos, reembolsos ni devoluciones bajo ninguna circunstancia, salvo que la ley aplicable disponga expresamente lo contrario.\n\n## 9. Terminación del Servicio\n\nEl acceso al servicio podrá suspenderse o terminarse, con o sin causa y sin previo aviso, en particular ante un incumplimiento de estos términos, sin que ello genere derecho a compensación alguna.\n\n## 10. Modificaciones a los Términos\n\nEstos términos pueden ser actualizados en cualquier momento. El uso continuado del servicio tras la publicación de los cambios constituye la aceptación de los nuevos términos.\n\n## 11. Ley Aplicable y Jurisdicción\n\nEstos términos se rigen por las leyes de la República de Chile. Cualquier controversia derivada del uso del servicio será sometida a los tribunales ordinarios de justicia de la ciudad de Santiago de Chile, quedando los gastos y costas legales que se generen a cargo del usuario.\n\n## 12. Divisibilidad\n\nSi alguna disposición de estos términos fuera considerada inválida o inaplicable, dicha disposición se limitará o eliminará en la medida mínima necesaria, y el resto de los términos continuará en pleno vigor.\n\n## 13. Contacto\n\nAnte cualquier consulta relacionada con estos Términos de Servicio, puedes escribir a fsolism@franciscosolis.cl."}}'
  WHERE `slug` = 'terms-of-service' AND `translations` = '{}';
UPDATE `legal_pages` SET `translations` = '{"es":{"title":"Política de Privacidad","summary":"Qué información recoge el sitio, para qué se usa y cómo se protege.","body":"## 1. Introducción\n\nNos importa mucho la privacidad de los usuarios. Esta Política de Privacidad describe qué información se recopila, cómo se utiliza y qué medidas se toman para protegerla.\n\n## 2. Datos que Recopilamos\n\nNo perfilamos ni almacenamos datos identificables de los usuarios, a menos que el servicio lo requiera explícitamente para funcionar (por ejemplo, un formulario de contacto o una autenticación).\n\n## 3. Cómo Usamos los Datos\n\nCuando se requieren datos, sólo se recopilan los estrictamente necesarios para prestar el servicio, y se utilizan exclusivamente para dicho propósito, sin fines de marketing masivo ni venta a terceros.\n\n## 4. Minimización de Datos y No Perfilamiento\n\nNo se realiza perfilamiento de usuarios ni se generan segmentaciones con fines publicitarios. La recopilación de datos se limita al mínimo indispensable para el funcionamiento del servicio.\n\n## 5. Cookies y Tecnologías Similares\n\nEl servicio puede utilizar cookies u otras tecnologías similares estrictamente necesarias para su funcionamiento (por ejemplo, recordar el idioma o preferencias de interfaz). No se utilizan cookies de rastreo publicitario.\n\n## 6. Compartición de Datos con Terceros\n\nLos datos recopilados no se venden ni se comparten con terceros, salvo que sea estrictamente necesario para operar el servicio (por ejemplo, proveedores de infraestructura o correo) o que la ley lo exija.\n\n## 7. Seguridad de la Información\n\nLa información recopilada se resguarda con las medidas de seguridad técnicas y organizativas adecuadas, acordes al tipo de dato y al riesgo asociado, buscando prevenir accesos no autorizados, pérdida o alteración.\n\n## 8. Retención de Datos\n\nLos datos se conservan únicamente durante el tiempo necesario para cumplir con el propósito para el cual fueron recopilados, salvo que exista una obligación legal que exija un plazo mayor.\n\n## 9. Derechos del Usuario\n\nEl usuario puede solicitar en cualquier momento el acceso, la rectificación o la eliminación de los datos personales que se hayan recopilado, escribiendo a fsolism@franciscosolis.cl.\n\n## 10. Menores de Edad\n\nEl servicio no está dirigido a menores de edad y no se recopila de forma consciente información de menores sin el consentimiento de sus padres o tutores.\n\n## 11. Cambios a esta Política\n\nEsta Política de Privacidad puede ser actualizada periódicamente. Los cambios relevantes se reflejarán en la fecha de \"última actualización\" indicada en esta página.\n\n## 12. Contacto\n\nAnte cualquier consulta relacionada con esta Política de Privacidad, puedes escribir a fsolism@franciscosolis.cl."}}'
  WHERE `slug` = 'privacy-policy' AND `translations` = '{}';
