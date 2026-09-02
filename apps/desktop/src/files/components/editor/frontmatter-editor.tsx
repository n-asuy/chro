
import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Type,
  Hash,
  Calendar,
  ToggleLeft,
  List,
  Trash2,
  Code,
  Braces,
  LayoutList,
} from "lucide-react";
import { Button } from "@chro/ui/button";
import { Input } from "@chro/ui/input";
import { cn } from "@chro/ui/utils";
import {
  type Frontmatter,
  type FrontmatterScalar,
  type FrontmatterValue,
  getFrontmatterValueType,
  formatNestedValue,
  formatDateValue,
  parseDateValue,
} from "../../lib/frontmatter";

export type FrontmatterViewMode = "ui" | "source";

interface FrontmatterEditorProps {
  frontmatter: Frontmatter;
  onChange: (frontmatter: Frontmatter) => void;
  className?: string;
  viewMode: FrontmatterViewMode;
  onViewModeChange: (mode: FrontmatterViewMode) => void;
}

/**
 * The property types this panel can edit
 *
 * Values outside this set (nested maps, lists holding structure) are shown
 * read-only: every editable control here writes its draft back into the
 * document, so offering one for a value it cannot represent would rewrite it.
 */
type PropertyType = "text" | "number" | "boolean" | "date" | "tags";

const PROPERTY_TYPE_ICONS: Record<PropertyType, typeof Type> = {
  text: Type,
  number: Hash,
  date: Calendar,
  boolean: ToggleLeft,
  tags: List,
};

const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Checkbox",
  tags: "Tags",
};

/**
 * Obsidian-style frontmatter property editor
 * Displays properties in a collapsible panel with inline editing
 */
export function FrontmatterEditor({
  frontmatter,
  onChange,
  className,
  viewMode,
  onViewModeChange,
}: FrontmatterEditorProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isAddingProperty, setIsAddingProperty] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const newPropertyInputRef = useRef<HTMLInputElement>(null);

  const propertyEntries = useMemo(
    () => Object.entries(frontmatter),
    [frontmatter],
  );
  const hasProperties = propertyEntries.length > 0;

  useEffect(() => {
    if (isAddingProperty && newPropertyInputRef.current) {
      newPropertyInputRef.current.focus();
    }
  }, [isAddingProperty]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleAddProperty = useCallback(() => {
    setIsAddingProperty(true);
    setNewPropertyName("");
  }, []);

  const handleCancelAddProperty = useCallback(() => {
    setIsAddingProperty(false);
    setNewPropertyName("");
  }, []);

  const handleCommitAddProperty = useCallback(() => {
    const trimmed = newPropertyName.trim();
    if (!trimmed || trimmed in frontmatter) {
      handleCancelAddProperty();
      return;
    }

    onChange({ ...frontmatter, [trimmed]: "" });
    setIsAddingProperty(false);
    setNewPropertyName("");
    setEditingKey(trimmed);
  }, [newPropertyName, frontmatter, onChange, handleCancelAddProperty]);

  const handleNewPropertyKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCommitAddProperty();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelAddProperty();
      }
    },
    [handleCommitAddProperty, handleCancelAddProperty],
  );

  const handleUpdateProperty = useCallback(
    (key: string, value: FrontmatterValue) => {
      onChange({ ...frontmatter, [key]: value });
    },
    [frontmatter, onChange],
  );

  const handleDeleteProperty = useCallback(
    (key: string) => {
      const next = { ...frontmatter };
      delete next[key];
      onChange(next);
    },
    [frontmatter, onChange],
  );

  const handleChangePropertyType = useCallback(
    (key: string, newType: PropertyType) => {
      const currentValue = frontmatter[key];
      let newValue: FrontmatterValue;

      switch (newType) {
        case "text":
          newValue = currentValue === null ? "" : String(currentValue);
          break;
        case "number":
          newValue = typeof currentValue === "number" ? currentValue : 0;
          break;
        case "boolean":
          newValue = Boolean(currentValue);
          break;
        case "date":
          newValue = currentValue instanceof Date ? currentValue : new Date();
          break;
        case "tags":
          if (Array.isArray(currentValue)) {
            newValue = currentValue;
          } else if (typeof currentValue === "string" && currentValue) {
            newValue = [currentValue];
          } else {
            newValue = [];
          }
          break;
        default:
          newValue = "";
      }

      onChange({ ...frontmatter, [key]: newValue });
    },
    [frontmatter, onChange],
  );

  const handleToggleViewMode = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onViewModeChange(viewMode === "ui" ? "source" : "ui");
    },
    [viewMode, onViewModeChange],
  );

  // In source mode, don't show the UI editor
  if (viewMode === "source") {
    return (
      <div className={cn(className)}>
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground tracking-wide">
            Properties (Source)
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={handleToggleViewMode}
            title="Switch to UI view"
          >
            <LayoutList className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(className)}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={handleToggleExpand}
          className="flex flex-1 items-center gap-1 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground tracking-wide hover:bg-muted/50"
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span>Properties</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 mr-1"
          onClick={handleToggleViewMode}
          title="Switch to source view"
        >
          <Code className="size-3.5" />
        </Button>
      </div>

      {isExpanded && (
        <div className="px-2 pb-2">
          {hasProperties && (
            <div className="space-y-1">
              {propertyEntries.map(([key, value]) => (
                <PropertyRow
                  key={key}
                  propertyKey={key}
                  value={value}
                  isEditing={editingKey === key}
                  onStartEditing={() => setEditingKey(key)}
                  onStopEditing={() => setEditingKey(null)}
                  onUpdate={(newValue) => handleUpdateProperty(key, newValue)}
                  onDelete={() => handleDeleteProperty(key)}
                  onChangeType={(type) => handleChangePropertyType(key, type)}
                />
              ))}
            </div>
          )}

          {isAddingProperty ? (
            <div className="mt-1 flex items-center gap-1">
              <Input
                ref={newPropertyInputRef}
                type="text"
                value={newPropertyName}
                onChange={(e) => setNewPropertyName(e.target.value)}
                onKeyDown={handleNewPropertyKeyDown}
                onBlur={handleCommitAddProperty}
                placeholder="Property name"
                className="h-7 flex-1 text-[12px] px-2 border-custom-primary-100 focus:ring-1 focus:ring-custom-primary-100"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleCancelAddProperty}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 w-full justify-start gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={handleAddProperty}
            >
              <Plus className="size-3.5" />
              Add property
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface PropertyRowProps {
  propertyKey: string;
  value: FrontmatterValue;
  isEditing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onUpdate: (value: FrontmatterValue) => void;
  onDelete: () => void;
  onChangeType: (type: PropertyType) => void;
}

function PropertyRow({
  propertyKey,
  value,
  isEditing,
  onStartEditing,
  onStopEditing,
  onUpdate,
  onDelete,
  onChangeType,
}: PropertyRowProps) {
  const valueType = getFrontmatterValueType(value);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        onStopEditing();
      }
    },
    [onStopEditing],
  );

  const propertyType: PropertyType | null =
    valueType === "nested" ? null : valueType === "null" ? "text" : valueType;
  const TypeIcon = propertyType ? PROPERTY_TYPE_ICONS[propertyType] : Braces;

  return (
    <div className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-muted/30">
      <div className="relative">
        {propertyType ? (
          <button
            type="button"
            onClick={() => setShowTypeMenu((prev) => !prev)}
            className="mt-0.5 flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
            title={`Type: ${PROPERTY_TYPE_LABELS[propertyType]}`}
          >
            <TypeIcon className="size-3.5" />
          </button>
        ) : (
          <span
            className="mt-0.5 flex size-5 items-center justify-center text-muted-foreground/40"
            title="Nested (read-only)"
          >
            <TypeIcon className="size-3.5" />
          </span>
        )}
        {showTypeMenu && propertyType && (
          <PropertyTypeMenu
            currentType={propertyType}
            onSelect={(type) => {
              onChangeType(type);
              setShowTypeMenu(false);
            }}
            onClose={() => setShowTypeMenu(false)}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] font-medium text-foreground leading-tight">
          {propertyKey}
        </span>
        {propertyType ? (
          <PropertyValueEditor
            ref={inputRef}
            type={propertyType}
            value={value}
            isEditing={isEditing}
            onStartEditing={onStartEditing}
            onStopEditing={onStopEditing}
            onUpdate={onUpdate}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <NestedValuePreview value={value} />
        )}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="mt-0.5 size-5 opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-destructive"
        onClick={onDelete}
        title="Delete property"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}

interface PropertyValueEditorProps {
  type: PropertyType;
  value: FrontmatterValue;
  isEditing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onUpdate: (value: FrontmatterValue) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

const PropertyValueEditor = ({
  type,
  value,
  isEditing,
  onStartEditing,
  onStopEditing,
  onUpdate,
  onKeyDown,
}: PropertyValueEditorProps & { ref?: React.Ref<HTMLInputElement> }) => {
  switch (type) {
    case "text":
      return (
        <TextValueEditor
          value={value as string | null}
          isEditing={isEditing}
          onStartEditing={onStartEditing}
          onStopEditing={onStopEditing}
          onUpdate={onUpdate}
          onKeyDown={onKeyDown}
        />
      );
    case "number":
      return (
        <NumberValueEditor
          value={value as number | null}
          isEditing={isEditing}
          onStartEditing={onStartEditing}
          onStopEditing={onStopEditing}
          onUpdate={onUpdate}
          onKeyDown={onKeyDown}
        />
      );
    case "boolean":
      return (
        <BooleanValueEditor value={value as boolean} onUpdate={onUpdate} />
      );
    case "date":
      return (
        <DateValueEditor
          value={value as Date | string | null}
          onUpdate={onUpdate}
        />
      );
    case "tags":
      return (
        <TagsValueEditor
          value={value as FrontmatterScalar[] | null}
          onUpdate={onUpdate}
        />
      );
  }
};

/**
 * Read-only YAML rendering of a value the panel cannot edit
 */
function NestedValuePreview({ value }: { value: FrontmatterValue }) {
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground/80 leading-relaxed">
      {formatNestedValue(value)}
    </pre>
  );
}

interface TextValueEditorProps {
  value: string | null;
  isEditing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onUpdate: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

function TextValueEditor({
  value,
  isEditing,
  onStartEditing,
  onStopEditing,
  onUpdate,
  onKeyDown,
}: TextValueEditorProps) {
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  };

  const handleBlur = () => {
    onUpdate(draft);
    onStopEditing();
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        className="h-6 text-[12px] px-1 py-0 border-custom-primary-100 focus:ring-1 focus:ring-custom-primary-100"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onStartEditing}
      className="w-full text-left text-[12px] text-muted-foreground leading-relaxed hover:text-foreground min-h-[20px]"
    >
      {value || <span className="text-muted-foreground/60 italic">Empty</span>}
    </button>
  );
}

interface NumberValueEditorProps {
  value: number | null;
  isEditing: boolean;
  onStartEditing: () => void;
  onStopEditing: () => void;
  onUpdate: (value: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

function NumberValueEditor({
  value,
  isEditing,
  onStartEditing,
  onStopEditing,
  onUpdate,
  onKeyDown,
}: NumberValueEditorProps) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(String(value ?? ""));
  }, [value]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  };

  const handleBlur = () => {
    const num = Number.parseFloat(draft);
    onUpdate(Number.isNaN(num) ? 0 : num);
    onStopEditing();
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="number"
        value={draft}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        className="h-6 text-[12px] px-1 py-0 border-custom-primary-100 focus:ring-1 focus:ring-custom-primary-100"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onStartEditing}
      className="w-full text-left text-[12px] text-muted-foreground leading-relaxed hover:text-foreground min-h-[20px]"
    >
      {value ?? <span className="text-muted-foreground/60 italic">0</span>}
    </button>
  );
}

interface BooleanValueEditorProps {
  value: boolean;
  onUpdate: (value: boolean) => void;
}

function BooleanValueEditor({ value, onUpdate }: BooleanValueEditorProps) {
  return (
    <button
      type="button"
      onClick={() => onUpdate(!value)}
      className={cn(
        "flex size-4 items-center justify-center rounded border",
        value
          ? "border-custom-primary-100 bg-custom-primary-100 text-white"
          : "border-border bg-background hover:border-muted-foreground/60",
      )}
    >
      {value && (
        <svg
          className="size-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13l4 4L19 7"
          />
        </svg>
      )}
    </button>
  );
}

interface DateValueEditorProps {
  value: Date | string | null;
  onUpdate: (value: Date | null) => void;
}

function DateValueEditor({ value, onUpdate }: DateValueEditorProps) {
  const dateStr = value ? formatDateValue(value as Date | string) : "";

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const parsed = parseDateValue(e.target.value);
    onUpdate(parsed);
  };

  return (
    <Input
      type="date"
      value={dateStr}
      onChange={handleChange}
      className="h-6 text-[12px] px-1 py-0 w-auto"
    />
  );
}

interface TagsValueEditorProps {
  value: FrontmatterScalar[] | null;
  onUpdate: (value: FrontmatterScalar[]) => void;
}

function TagsValueEditor({ value, onUpdate }: TagsValueEditorProps) {
  const tags = value ?? [];
  const [isAdding, setIsAdding] = useState(false);
  const [newTag, setNewTag] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isAdding]);

  const handleRemoveTag = (tag: FrontmatterScalar) => {
    onUpdate(tags.filter((t) => t !== tag));
  };

  const handleAddTag = () => {
    const trimmed = newTag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onUpdate([...tags, trimmed]);
    }
    setNewTag("");
    setIsAdding(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsAdding(false);
      setNewTag("");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={String(tag)}
          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
        >
          {String(tag)}
          <button
            type="button"
            onClick={() => handleRemoveTag(tag)}
            className="ml-0.5 text-muted-foreground/60 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {isAdding ? (
        <Input
          ref={inputRef}
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onBlur={handleAddTag}
          onKeyDown={handleKeyDown}
          placeholder="Tag"
          className="h-5 w-20 text-[11px] px-1 py-0"
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsAdding(true)}
          className="inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1 py-0.5 text-[10px] text-muted-foreground/60 hover:border-muted-foreground/60 hover:text-muted-foreground"
        >
          <Plus className="size-2.5" />
          Add
        </button>
      )}
    </div>
  );
}

interface PropertyTypeMenuProps {
  currentType: PropertyType;
  onSelect: (type: PropertyType) => void;
  onClose: () => void;
}

function PropertyTypeMenu({
  currentType,
  onSelect,
  onClose,
}: PropertyTypeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const types: PropertyType[] = ["text", "number", "boolean", "date", "tags"];

  return (
    <div
      ref={menuRef}
      className="absolute left-0 top-full z-50 mt-1 min-w-[120px] rounded-xl border bg-popover py-1 shadow-sm"
    >
      {types.map((type) => {
        const Icon = PROPERTY_TYPE_ICONS[type];
        const isSelected = type === currentType;
        return (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted",
              isSelected && "bg-custom-primary-100/10 text-custom-primary-100",
            )}
          >
            <Icon className="size-3.5" />
            {PROPERTY_TYPE_LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}
