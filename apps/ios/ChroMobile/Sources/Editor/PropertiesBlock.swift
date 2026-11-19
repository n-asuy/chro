import ChroDomain
import SwiftUI

/// The frontmatter properties above a note (frontmatter-editor.tsx, the
/// mock's `.props`): collapsible rows with a type button, the key and an
/// editable value; the long-press menu deletes; Add property; the code button swaps
/// to the source layout. Every change rewrites the frontmatter block.
struct PropertiesBlock: View {
    let document: TextDocument
    @Binding var source: Bool
    @Environment(SheetPresenter.self) private var sheets
    @State private var collapsed = false
    @State private var editing: String?
    @State private var draft = ""
    @State private var adding = false
    @State private var newName = ""
    @State private var deleting: String?
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case name
        case value(String)
    }

    private var lines: [String] { document.text.components(separatedBy: "\n") }
    private var properties: [FrontmatterProperty] { Frontmatter.parse(lines).properties }
    private var editable: Bool { document.isEditable }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Button { collapsed.toggle() } label: {
                    HStack(spacing: 4) {
                        Icon(collapsed ? .chevronRight : .chevronDown, size: 15)
                        Text("Properties").textStyle(TextStyle(size: 12.5, weight: 500, tracking: 0.02))
                    }
                    .foregroundStyle(Palette.t300)
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(collapsed ? [] : .isSelected)
                IconButton(icon: .code, size: 16, label: "Switch to source view") { source = true }
            }
            if !collapsed {
                ForEach(Array(properties.enumerated()), id: \.offset) { index, property in
                    row(property, index: index)
                }
                if adding {
                    HStack(alignment: .center, spacing: 6) {
                        Icon(.plus, size: 15).foregroundStyle(Palette.t300.opacity(0.6)).frame(width: 32, height: 36)
                        TextField("", text: $newName, prompt: Text("Property name").foregroundStyle(Palette.t300))
                            .textStyle(TextStyle(size: 13.5))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .name)
                            .padding(.horizontal, 6)
                            .frame(height: 32)
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.primary))
                            .onSubmit(commitName)
                            .onAppear { focusedField = .name }
                        IconButton(icon: .x, size: 15, label: "Cancel") { adding = false; newName = "" }
                    }
                    .padding(4)
                } else if editable {
                    Button { adding = true } label: {
                        HStack(spacing: 6) {
                            Icon(.plus, size: 15)
                            Text("Add property").textStyle(TextStyle(size: 12.5))
                        }
                        .foregroundStyle(Palette.t300)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: Rows

    private func row(_ property: FrontmatterProperty, index: Int) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Button { sheets.present { typeSheet(property) } } label: {
                Icon(Self.icon(property.value.type), size: 15).foregroundStyle(Palette.t300.opacity(0.6))
                    // A 32pt column, a 44pt hit area reaching past it.
                    .frame(width: 44, height: 44).contentShape(Rectangle()).padding(.horizontal, -6)
            }
            .buttonStyle(.plain)
            .disabled(!editable || property.value.isNested)
            .accessibilityLabel("Type: \(property.value.isNested ? "Nested (read-only)" : property.value.type.label)")
            VStack(alignment: .leading, spacing: 2) {
                Text(property.key).textStyle(TextStyle(size: 12.5, weight: 500)).foregroundStyle(Palette.fg)
                value(property)
            }
            .padding(.top, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(4)
        .frame(minHeight: 44)
        .background(Palette.bg)
        // The desktop's hover-only delete becomes the row's long-press menu: a
        // system context menu wins over the value's tap, so pressing a value no longer starts editing it.
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            if editable {
                Button("Delete property", systemImage: "trash", role: .destructive) { deleting = property.key }
            }
        }
        // Anchored to the pressed row: on the whole block, the dialog opened
        // at the top of the screen, away from the property it deletes.
        .confirmationDialog("", isPresented: Binding(get: { deleting == property.key }, set: { if !$0 { deleting = nil } })) {
            Button("Delete property", role: .destructive) {
                write(properties.filter { $0.key != property.key })
                deleting = nil
            }
            Button("Cancel", role: .cancel) { deleting = nil }
        }
        .accessibilityAction(named: "Delete property") { if editable { deleting = property.key } }
    }

    @ViewBuilder private func value(_ property: FrontmatterProperty) -> some View {
        switch property.value {
        case .checkbox(let on):
            Button { update(property.key, .checkbox(!on)) } label: {
                CheckboxMark(isOn: on)
                    .frame(width: 44, height: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!editable)
            .accessibilityLabel(property.key)
            .accessibilityValue(on ? "true" : "false")
        case .tags(let tags):
            FlowLayout(spacing: 4) {
                ForEach(Array(tags.enumerated()), id: \.offset) { position, tag in
                    HStack(spacing: 2) {
                        Text(tag).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.fg)
                        Button { update(property.key, .tags(tags.enumerated().filter { $0.offset != position }.map(\.element))) } label: {
                            // The tag keeps its size; the hit area reaches 44pt around the glyph.
                            Icon(.x, size: 11).frame(width: 44, height: 44).contentShape(Rectangle()).padding(.horizontal, -10).padding(.vertical, -8)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.t300)
                        .disabled(!editable)
                        .accessibilityLabel("Remove \(tag)")
                    }
                    .padding(.leading, 6)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Palette.muted))
                }
                if editing == property.key {
                    inlineField(property.key, placeholder: "Tag") { commit(property) }
                } else if editable {
                    Button { begin(property) } label: {
                        HStack(spacing: 2) {
                            Icon(.plus, size: 11)
                            Text("Add").textStyle(TextStyle(size: 12))
                        }
                        .foregroundStyle(Palette.t300)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 28)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        case .date(let text):
            DatePicker("", selection: Binding(get: { Self.dateFormatter.date(from: text) ?? Date() },
                                              set: { update(property.key, .date(Self.dateFormatter.string(from: $0))) }),
                       displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.compact)
                .disabled(!editable)
                .accessibilityLabel(property.key)
        case .nested(let text):
            Text(text).textStyle(.code(12)).foregroundStyle(Palette.t300)
        case .text, .number:
            if editing == property.key {
                inlineField(property.key, placeholder: "", number: property.value.type == .number) { commit(property) }
            } else {
                let empty = property.value.display.isEmpty
                Button { if editable { begin(property) } } label: {
                    Text(empty ? (property.value.type == .number ? "0" : "Empty") : property.value.display)
                        .textStyle(TextStyle(size: 13.5))
                        .italic(empty && property.value.type != .number)
                        .foregroundStyle(Palette.t300.opacity(empty ? 0.6 : 1))
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(property.key)
                .accessibilityValue(property.value.display)
            }
        }
    }

    private func inlineField(_ key: String, placeholder: String, number: Bool = false, onCommit: @escaping () -> Void) -> some View {
        TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Palette.t300))
            .textStyle(TextStyle(size: 13.5))
            .keyboardType(number ? .decimalPad : .default)
            .textInputAutocapitalization(.never)
            .focused($focusedField, equals: .value(key))
            .padding(.horizontal, 6)
            .frame(height: 32)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.primary))
            .onSubmit(onCommit)
            .onChange(of: focusedField) { previous, now in if previous == .value(key), now != .value(key) { onCommit() } }
            .task { focusedField = .value(key) }
            .accessibilityLabel(key)
    }

    // MARK: Type sheet

    private func typeSheet(_ property: FrontmatterProperty) -> some View {
        VStack(spacing: 0) {
            SheetHeader(title: property.key)
            SheetMenu {
                ForEach(FrontmatterValue.Kind.allCases, id: \.self) { kind in
                    MenuItem(icon: Self.icon(kind), title: kind.label, checked: property.value.type == kind) {
                        update(property.key, property.value.converted(to: kind, today: Self.dateFormatter.string(from: Date())))
                        sheets.dismiss()
                    }
                }
            }
        }
    }

    // MARK: Writes

    private func begin(_ property: FrontmatterProperty) {
        if case .tags = property.value { draft = "" } else { draft = property.value.display }
        editing = property.key
    }

    /// Enter or leaving the field: tags add (deduplicated), numbers parse (else 0), text as typed.
    private func commit(_ property: FrontmatterProperty) {
        guard editing == property.key else { return }
        editing = nil
        switch property.value {
        case .tags(let tags):
            let tag = draft.trimmingCharacters(in: .whitespaces)
            if !tag.isEmpty, !tags.contains(tag) { update(property.key, .tags(tags + [tag])) }
        case .number:
            update(property.key, .number(Double(draft.trimmingCharacters(in: .whitespaces)) ?? 0))
        default:
            update(property.key, .text(draft))
        }
    }

    /// Empty or duplicate names cancel; a new key starts as empty text and opens for editing.
    private func commitName() {
        let key = newName.trimmingCharacters(in: .whitespaces)
        adding = false
        newName = ""
        guard !key.isEmpty, !properties.contains(where: { $0.key == key }) else { return }
        write(properties + [FrontmatterProperty(key: key, value: .text(""))])
        draft = ""
        editing = key
    }

    private func update(_ key: String, _ value: FrontmatterValue) {
        var properties = self.properties
        guard let index = properties.firstIndex(where: { $0.key == key }), properties[index].value != value else { return }
        properties[index].value = value
        write(properties)
    }

    private func write(_ properties: [FrontmatterProperty]) {
        document.edit(Frontmatter.write(properties, into: lines).joined(separator: "\n"))
    }

    static func icon(_ kind: FrontmatterValue.Kind) -> LucideName {
        switch kind {
        case .text: .type
        case .number: .hash
        case .checkbox: .toggleLeft
        case .date: .calendar
        case .tags: .list
        }
    }

    static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

private extension FrontmatterValue {
    var isNested: Bool { if case .nested = self { true } else { false } }
}
