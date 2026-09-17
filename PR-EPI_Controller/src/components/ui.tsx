//-----------------------------------------------------------------------
// Primitivas de UI compartidas (estilo técnico/ingeniería, alineado con
// el informe HTML: cabecera de sección con barra izquierda azul, etc.).
//-----------------------------------------------------------------------

import type { ReactNode } from "react";

export function Section({
    title,
    sub,
    children,
}: {
    title: string;
    sub?: string;
    children: ReactNode;
}) {
    return (
        <section className="mb-8">
            <div className="flex items-center justify-between border-l-4 border-primary bg-secondary border-y border-r border-border rounded-r-md px-3 py-2 mb-3.5">
                <h2 className="text-300 font-mono uppercase tracking-[0.16em] text-foreground font-bold">
                    {title}
                </h2>
                {sub && (
                    <span className="font-mono text-200 text-muted-foreground tracking-[0.06em]">
                        {sub}
                    </span>
                )}
            </div>
            {children}
        </section>
    );
}

export function ChartWrap({ children }: { children: ReactNode }) {
    return (
        <div className="border border-border border-l-4 border-l-primary bg-card rounded-r-md p-4 h-[340px]">
            {children}
        </div>
    );
}
