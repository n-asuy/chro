import Testing
@testable import ChroDomain

/// Values computed with the mock's hueTo (project-color-picker.tsx).
struct ProjectColorTests {
    @Test func cornersAndMiddle() {
        #expect(ProjectColorPicker.hex(x: 0, y: 0, saturation: 55) == "#eb6a6a")
        #expect(ProjectColorPicker.hex(x: 0.5, y: 0.5, saturation: 55) == "#469c9c")
        #expect(ProjectColorPicker.hex(x: 1, y: 1, saturation: 100) == "#4d1313")
    }

    @Test func outOfFieldClamps() {
        #expect(ProjectColorPicker.hex(x: -1, y: 2, saturation: 55) == ProjectColorPicker.hex(x: 0, y: 1, saturation: 55))
    }
}
