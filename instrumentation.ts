export async function register() {
  // Gate on Node.js runtime — Firebase Admin SDK and Razorpay are Node.js-only;
  // this prevents import errors if the Edge runtime also loads this file.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/env')
  }
}
