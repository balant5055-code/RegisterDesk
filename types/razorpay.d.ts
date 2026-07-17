// Single ambient global type for the Razorpay Checkout script
// (loaded at runtime from https://checkout.razorpay.com/v1/checkout.js).
//
// Consumers build their own strongly-typed options object and pass it here; the
// global accepts any object so multiple call sites can coexist without competing
// `declare global` augmentations (which previously conflicted at type-check time).

interface RazorpayCheckoutInstance {
  open(): void
}

interface Window {
  Razorpay: new (options: Record<string, unknown>) => RazorpayCheckoutInstance
}
