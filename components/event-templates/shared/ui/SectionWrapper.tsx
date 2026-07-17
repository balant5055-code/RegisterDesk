import type { ReactNode } from 'react'

export function SectionWrapper({ title, subtitle, children, id }: {
  title:     string
  subtitle?: string
  children:  ReactNode
  id?:       string
}) {
  return (
    <section id={id} className="py-5 sm:py-6">
      <div className="mb-3.5">
        <div
          className="mb-1.5 h-[3px] w-6 rounded-full"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        />
        <h2 className="text-[14.5px] font-bold tracking-tight text-foreground sm:text-[16px]">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  )
}
