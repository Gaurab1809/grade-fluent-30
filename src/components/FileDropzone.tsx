import { useCallback, useState } from "react";
import { Upload, FileText, ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  file: File | null;
  previewUrl: string | null;
  onFile: (file: File | null) => void;
};

export function FileDropzone({ file, previewUrl, onFile }: Props) {
  const [drag, setDrag] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  if (file && previewUrl) {
    const isImage = file.type.startsWith("image/");
    return (
      <div className="relative rounded-xl border border-border bg-card overflow-hidden group">
        <button
          onClick={() => onFile(null)}
          className="absolute top-2 right-2 z-10 h-7 w-7 rounded-full bg-background/80 backdrop-blur border border-border flex items-center justify-center hover:bg-background transition-colors"
          aria-label="Remove file"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {isImage ? (
          <img src={previewUrl} alt={file.name} className="w-full h-64 object-contain bg-muted" />
        ) : (
          <div className="h-64 flex flex-col items-center justify-center bg-muted text-muted-foreground gap-2">
            <FileText className="h-10 w-10" />
            <span className="text-sm">PDF preview</span>
            <a href={previewUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
              Open in new tab
            </a>
          </div>
        )}
        <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground flex items-center gap-2">
          {isImage ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
          <span className="truncate">{file.name}</span>
          <span className="ml-auto">{(file.size / 1024).toFixed(0)} KB</span>
        </div>
      </div>
    );
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
      className={cn(
        "block rounded-xl border-2 border-dashed border-border bg-card cursor-pointer transition-all",
        "hover:border-accent hover:bg-accent/5 px-6 py-10 text-center",
        drag && "border-accent bg-accent/10",
      )}
    >
      <input
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
        <Upload className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-display text-base text-foreground">Drop an exam paper here</p>
      <p className="text-sm text-muted-foreground mt-1">PDF or image · Bangla or English handwriting</p>
      <p className="text-xs text-muted-foreground mt-3">or click to browse</p>
    </label>
  );
}
