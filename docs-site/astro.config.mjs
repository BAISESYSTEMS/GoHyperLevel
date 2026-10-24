// @ts-check
// Documentation website (docs.gohyperlevel.com). The content is generated from ../docs by scripts/sync-docs.mjs.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const sidebar = JSON.parse(readFileSync(new URL('./src/sidebar.generated.json', import.meta.url), 'utf8'));

export default defineConfig({
	site: 'https://docs.gohyperlevel.com',
	integrations: [
		starlight({
			title: 'HyperLevel Docs',
			description: 'Documentation for HyperLevel – the open-source business OS your AI agents run on.',
			logo: { light: './src/assets/logo.svg', dark: './src/assets/logo-dark.svg', replacesTitle: true },
			favicon: '/favicon.svg',
			defaultLocale: 'root',
			locales: {
				root: { label: 'English', lang: 'en' },
				de: { label: 'Deutsch', lang: 'de' },
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/BAISESYSTEMS/GoHyperLevel' },
			],
			editLink: { baseUrl: 'https://github.com/BAISESYSTEMS/GoHyperLevel/edit/main/docs/' },
			customCss: ['./src/styles/brand.css'],
			lastUpdated: false,
			pagination: true,
			sidebar,
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.gohyperlevel.com/og.png' } },
			],
		}),
	],
});
