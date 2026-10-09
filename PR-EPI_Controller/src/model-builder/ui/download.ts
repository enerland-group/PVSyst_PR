//-----------------------------------------------------------------------
// Browser download helper.
//-----------------------------------------------------------------------

export function saveBlob(data: ArrayBuffer | Uint8Array | string, fileName: string, mime: string) {
    const blob = new Blob([data as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
