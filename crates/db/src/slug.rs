use nanoid::nanoid;

const SLUG_ALPHABET: [char; 62] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B',
    'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U',
    'V', 'W', 'X', 'Y', 'Z',
];

const SLUG_LENGTH: usize = 8;

pub fn generate_slug() -> String {
    nanoid!(SLUG_LENGTH, &SLUG_ALPHABET)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn slug_has_correct_length() {
        let slug = generate_slug();
        assert_eq!(slug.len(), SLUG_LENGTH);
    }

    #[test]
    fn slug_is_alphanumeric() {
        let slug = generate_slug();
        assert!(slug.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn slugs_are_unique() {
        let slugs: HashSet<String> = (0..1000).map(|_| generate_slug()).collect();
        assert_eq!(slugs.len(), 1000);
    }
}
