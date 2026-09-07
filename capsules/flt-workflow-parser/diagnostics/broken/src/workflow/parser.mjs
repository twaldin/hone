// Trusted broken control: protocol-valid, deterministically wrong.
export function parseWorkflowText(_text) {
  return { name: 'broken-control', steps: [{ id: 'broken', run: 'false' }] }
}
