import { defineConfig } from 'vite';

// The page imports the fixed fixture and evaluation record from the repository root.
export default defineConfig({ server: { fs: { allow: ['../..'] } } });
