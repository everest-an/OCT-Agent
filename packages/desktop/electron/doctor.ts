// Re-export shim — implementation lives in electron/doctor/
// `import { createDoctor } from './doctor'` in main.ts resolves to this file,
// which forwards everything from the split module.
export * from './doctor/index';
