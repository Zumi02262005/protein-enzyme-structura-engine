import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local-only app: `npm run dev` serves it at http://localhost:5173
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
});
