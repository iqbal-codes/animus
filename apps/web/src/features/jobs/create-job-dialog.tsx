import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { client } from "@/lib/factory-client";

export function CreateJobDialog({
  open,
  onOpenChange,
  projectId,
  onJobCreated,
  factory = client,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onJobCreated?: (workId: string) => void;
  factory?: typeof client;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await factory.forProject(projectId).createJob({
        title: title.trim() || undefined,
        prompt: prompt.trim(),
      });
      setTitle("");
      setPrompt("");
      onOpenChange(false);
      onJobCreated?.(result.work.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create job");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New Job</DialogTitle>
            <DialogDescription>
              Create a new job directly in Animus without publishing an issue to GitHub. Animus will
              allocate a local work item and run it through triage refinement.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="job-title" className="text-xs font-medium text-foreground">
              Title <span className="text-[var(--text-muted)]">(optional)</span>
            </Label>
            <Input
              id="job-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Add validation middleware"
              className="text-xs"
              disabled={isSubmitting}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="job-prompt" className="text-xs font-medium text-foreground">
              Task Prompt <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="job-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to implement, acceptance criteria, or rough task description..."
              rows={5}
              className="min-h-[120px] text-xs"
              required
              disabled={isSubmitting}
            />
          </div>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !prompt.trim()}>
              {isSubmitting && <LoaderCircle className="mr-2 size-4 animate-spin" />}
              Create Job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
