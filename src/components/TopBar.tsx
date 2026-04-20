import { Link } from "@tanstack/react-router";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { Moon, Sun, BookOpenCheck, LogOut, History } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TopBar({ onOpenHistory }: { onOpenHistory?: () => void }) {
  const { theme, toggle } = useTheme();
  const { user, signOut } = useAuth();
  const initial = (user?.user_metadata?.display_name || user?.email || "?").toString().charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 font-display text-lg text-foreground">
          <BookOpenCheck className="h-5 w-5 text-accent" />
          <span>Khata</span>
        </Link>
        <div className="flex items-center gap-1">
          {onOpenHistory && (
            <Button variant="ghost" size="sm" onClick={onOpenHistory}>
              <History className="h-4 w-4 mr-1.5" /> History
            </Button>
          )}
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted transition-colors"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <div className="ml-2 flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
              {initial}
            </div>
            <button onClick={() => signOut()} className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-muted text-muted-foreground" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
