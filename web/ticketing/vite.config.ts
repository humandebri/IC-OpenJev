import { defineConfig } from 'vite';

// The page imports the fixed fixture and evaluation record from the repository root.
export default defineConfig({ server: { proxy: { '/api/it-routing': 'http://127.0.0.1:5191' }, fs: { allow: ['../..'] } } });
