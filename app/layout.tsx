import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import 'swiper/css'
import 'swiper/css/pagination'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: 'RegisterDesk',
  description: 'Event registration and check-in platform',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
