import { useCallback, useState } from "react";
import { Upload, FileText, ImageIcon, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  files: File[];
  onFiles: (files: File[]) => void;
};

export function FileDropzone({ files, onFiles }: Props) {
  const [drag, setDrag] = useState(false);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming).filter(
        (f) => f.type.startsWith("image/") || f.type === "application/pdf",
      );
      if (arr.length === 0) return;
      onFiles([...files, ...arr]);
    },
    [files, onFiles],
  );

  const removeAt = (idx: number) => onFiles(files.filter((_, i) => i !== idx));

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  if (files.length > 0) {
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          {files.map((f, idx) => {
            const isImage = f.type.startsWith("image/");
            const url = URL.createObjectURL(f);
            return (
              <div
                key={idx}
                className="relative rounded-lg border border-border bg-card overflow-hidden group"
              >
                <button
                  onClick={() => removeAt(idx)}
                  className="absolute top-1.5 right-1.5 z-10 h-6 w-6 rounded-full bg-background/90 backdrop-blur border border-border flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
                {isImage ? (
                  <img
                    src={url}
                    alt={f.name}
                    className="w-full h-32 object-cover bg-muted"
                    onLoad={() => URL.revokeObjectURL(url)}
                  />
                ) : (
                  <div className="h-32 flex flex-col items-center justify-center bg-muted text-muted-foreground gap-1">
                    <FileText className="h-7 w-7" />
                    <span className="text-[10px]">PDF</span>
                  </div>
                )}
                <div className="px-2 py-1.5 border-t border-border text-[11px] text-muted-foreground flex items-center gap-1">
                  {isImage ? <ImageIcon className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{f.name}</span>
                </div>
              </div>
            );
          })}
        </div>
        <label
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card hover:bg-accent/5 hover:border-accent text-sm text-muted-foreground py-3 cursor-pointer transition-colors"
        >
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
          <Plus className="h-4 w-4" /> Add another page
        </label>
        <p className="text-[11px] text-muted-foreground text-center">
          {files.length} file{files.length === 1 ? "" : "s"} · all pages will be transcribed together
        </p>
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
        multiple
        className="hidden"
        onChange={(e) => e.target.files && addFiles(e.target.files)}
      />
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
        <Upload className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-display text-base text-foreground">Drop exam pages here</p>
      <p className="text-sm text-muted-foreground mt-1">
        One or more PDFs / images · Bangla or English handwriting
      </p>
      <p className="text-xs text-muted-foreground mt-3">or click to browse</p>
    </label>
  );
}
