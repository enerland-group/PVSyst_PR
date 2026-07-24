//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect } from "react";

/**
 * Detects the current color scheme preference and toggles the `dark`
 * class on `<html>`. Listens for changes to `prefers-color-scheme` and
 * the `data-appearance` attribute on `<html>`.
 */
export function useAppTheme() {
    const [isDark, setIsDark] = useState(() => {
        // Por defecto tema CLARO. Solo arranca en oscuro si el host (Fabric) lo
        // indica explícitamente con data-appearance="dark". No seguimos la
        // preferencia del SO para que el fondo sea claro por defecto.
        const appearance = document.documentElement.getAttribute("data-appearance");
        return appearance === "dark";
    });

    useEffect(() => {
        // Sync the .dark class on <html> for Tailwind dark mode
        document.documentElement.classList.toggle("dark", isDark);
    }, [isDark]);

    useEffect(() => {
        // Solo observamos data-appearance del host (Fabric). No seguimos el SO.
        const observer = new MutationObserver(() => {
            const appearance = document.documentElement.getAttribute("data-appearance");
            if (appearance === "dark") setIsDark(true);
            else if (appearance === "light") setIsDark(false);
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-appearance"],
        });

        return () => {
            observer.disconnect();
        };
    }, []);

    const toggleTheme = () => setIsDark((prev: boolean) => !prev);

    return { isDark, toggleTheme };
}
