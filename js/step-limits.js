import { setting } from "./storage.js";

export const STEP_LIMITS = Object.freeze({
  orchestratorSteps: { default: 20, min: 1, max: 100 },
  subagentSteps: { default: 90, min: 1, max: 300 }
});

export function stepLimits() {
  return Object.fromEntries(Object.entries(STEP_LIMITS).map(([name, bounds]) => {
    const value = Number(setting(name));
    return [name, Number.isInteger(value) && value >= bounds.min && value <= bounds.max ? value : bounds.default];
  }));
}

export function bindStepLimits(byId) {
  for (const [name, bounds] of Object.entries(STEP_LIMITS)) {
    const field = byId(name);
    field.min = bounds.min;
    field.max = bounds.max;
    field.step = 1;
    field.value = stepLimits()[name];
    field.oninput = () => {
      if (field.value && field.checkValidity()) setting(name, field.value);
    };
    field.onchange = () => { field.value = stepLimits()[name]; };
  }
}
