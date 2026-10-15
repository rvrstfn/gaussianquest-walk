import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Served over HTTPS with a self-signed certificate so WebXR works both through
// `metavr adb reverse tcp:5173 tcp:5173` (https://localhost:5173) and over
// Wi-Fi (https://<this PC's LAN IP>:5173, accept the certificate warning once).
export default defineConfig({
    plugins: [basicSsl({ name: 'gaussianquest' })],
    server: { port: 5173, strictPort: true, host: true },
    preview: { port: 5173, strictPort: true, host: true },
    build: { target: 'es2022' }
});
