import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'three/examples/jsm/utils/BufferGeometryUtils': path.resolve(__dirname, 'src/shims/BufferGeometryUtils.js'),
      'three/examples/jsm/utils/BufferGeometryUtils.js': path.resolve(__dirname, 'src/shims/BufferGeometryUtils.js')
    }
  }
});