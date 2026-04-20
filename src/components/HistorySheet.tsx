import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FileText, Trash2 } from "lucide-react";
import { toast } from "sonner";

type Eval = {
  id: string;
  title: string;
  status: string;
  total_score: number | null;
  max_score: number | null;
  created_at: string;
};

export function HistorySheet({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const [items, setItems] = useState<Eval[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    supabase
      .from("evaluations")
      .select("id,title,status,total_score,max_score,created_at")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        else setItems((data ?? []) as Eval[]);
        setLoading(false);
      });
  }, [open]);

  const remove = async (id: string) => {
    const { error } = await supabase.from("evaluations").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setItems((it) => it.filter((x) => x.id !== id));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl">History</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-2 overflow-y-auto h-[calc(100vh-8rem)] pr-2">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && items.length === 0 && (
            <p className="text-sm text-muted-foreground">No papers yet. Upload one to get started.</p>
          )}
          {items.map((it) => (
            <div
              key={it.id}
              className="group flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors"
            >
              <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                <FileText className="h-4 w-4 text-muted-foreground" />
              </div>
              <button
                onClick={() => { onSelect(it.id); onOpenChange(false); }}
                className="flex-1 text-left min-w-0"
              >
                <div className="text-sm font-medium text-foreground truncate">{it.title}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(it.created_at).toLocaleDateString()} ·{" "}
                  <span className="capitalize">{it.status}</span>
                  {it.total_score != null && it.max_score != null && (
                    <> · <span className="text-accent font-medium">{it.total_score}/{it.max_score}</span></>
                  )}
                </div>
              </button>
              <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100" onClick={() => remove(it.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
