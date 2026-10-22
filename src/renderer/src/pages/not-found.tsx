import { Compass } from "lucide-react";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button-variants";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function NotFoundPage() {
  useDocumentTitle("Not found");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-accent text-muted-foreground">
        <Compass className="size-6" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Nothing here</h1>
        <p className="text-sm text-muted-foreground">
          This page doesn't exist. Maybe the link is old.
        </p>
      </div>
      <Link to="/" className={buttonVariants({ variant: "outline" })}>
        Go home
      </Link>
    </div>
  );
}
