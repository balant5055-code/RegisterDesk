import { Navbar } from '@/components/layout/navbar'
import HeroSection from '@/components/sections/hero'
import AudienceGrid from '@/components/sections/audience-grid'

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <HeroSection />
        <AudienceGrid />
      </main>
    </>
  )
}
