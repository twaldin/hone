pub trait CaseExt {
    type Owned;

    /// Create a new string from a string slice with replacing the first character with its
    /// to ASCII upper case counterpart (if one exists).
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!(&CaseExt::to_capitalized("stringy string"), "Stringy string");
    /// assert_eq!(&CaseExt::to_capitalized("言語"), "言語");
    /// ```
    fn to_capitalized(&self) -> Self::Owned;

    /// Check whether a string is capitalized.
    ///
    /// If the the list is empty, the string is not considered capitalized.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!("Stringy string".is_capitalized(), true);
    /// assert_eq!("hello world".is_capitalized(), false);
    /// assert_eq!("".is_capitalized(), false);
    /// ```
    fn is_capitalized(&self) -> bool;

    /// Convert a string slice from snake case to a new capitalized camel case string.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!(&"a_string_and_a_miss".to_camel(), "AStringAndAMiss");
    /// assert_eq!(&"fooby".to_camel(), "Fooby");
    /// assert_eq!(&"_wild__underscore_s_".to_camel(), "WildUnderscoreS");
    /// assert_eq!(&"言_語".to_camel(), "言語");
    /// ```
    fn to_camel(&self) -> Self::Owned;

    /// Convert a string slice from snake case to a new uncapitalized camel case string.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!(&"string_henry_iii".to_camel_lowercase(), "stringHenryIii");
    /// assert_eq!(&"fooby".to_camel_lowercase(), "fooby");
    /// assert_eq!(&"_wild__underscore_s_".to_camel_lowercase(), "wildUnderscoreS");
    /// assert_eq!(&"言_語".to_camel_lowercase(), "言語");
    /// ```
    fn to_camel_lowercase(&self) -> Self::Owned;

    /// Check whether a string is in camel lowercase.
    ///
    /// If the the list is empty, the string is not considered camel lowercase.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!("Stringy string".is_camel_lowercase(), false);
    /// assert_eq!("helloWorld".is_camel_lowercase(), true);
    /// assert_eq!("WildUnderscoreS".is_camel_lowercase(), false);
    /// assert_eq!("".is_capitalized(), false);
    /// ```
    fn is_camel_lowercase(&self) -> bool;

    /// Convert a string from camel case to snake case.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!(&"martinLutherStringJr".to_snake(), "martin_luther_string_jr");
    /// assert_eq!(&"fooby".to_snake(), "fooby");
    /// assert_eq!(&"WildUnderscoreS".to_snake(), "wild_underscore_s");
    /// assert_eq!(&"言語".to_snake(), "言語");
    /// ```
    fn to_snake(&self) -> Self::Owned;

    /// Replaces underscores with dashes in a string.
    ///
    /// # Examples
    ///
    /// ```
    /// use case::CaseExt;
    ///
    /// assert_eq!(&"stringing_in_the_rain".to_dashed(), "stringing-in-the-rain");
    /// ```
    fn to_dashed(&self) -> Self::Owned;
}

impl CaseExt for str {
    type Owned = String;

    fn to_capitalized(&self) -> Self::Owned {
        let mut result = String::with_capacity(self.len());

        for (i, c) in self.chars().enumerate() {
            result.push(if i == 0 {
                c.to_ascii_uppercase()
            } else {
                c
            });
        }

        result
    }

    fn is_capitalized(&self) -> bool {
        if let Some(first) = self.chars().next() {
            first.is_uppercase()
        } else {
            false
        }
    }

    fn to_camel(&self) -> String {
        to_camel_internal(self, true)
    }

    fn is_camel_lowercase(&self) -> bool {
        match self.chars().next() {
            Some(first) if first.is_uppercase() => return false,
            _ => ()
        }

        !self.contains('_')
    }

    fn to_camel_lowercase(&self) -> String {
        to_camel_internal(self, false)
    }

    fn to_snake(&self) -> String {
        // The first character is never prepended with an underscore, so skip it even if it is an
        // uppercase ASCII character.
        let underscore_count = self.chars().skip(1).filter(|&c| is_ascii_uppercase(c)).count();
        let mut result = String::with_capacity(self.len() + underscore_count);

        for (i, c) in self.chars().enumerate() {
            if is_ascii_uppercase(c) {
                if i != 0 {
                    result.push('_');
                }
                result.push(c.to_ascii_lowercase());
            } else {
                result.push(c);
            }
        }

        result
    }

    fn to_dashed(&self) -> String {
        let mut result = String::with_capacity(self.len());

        for c in self.chars() {
            result.push(match c {
                '_' => '-',
                c => c
            });
        }

        result
    }
}

fn to_camel_internal(term: &str, uppercase_first_letter: bool) -> String {
    let underscore_count = term.chars().filter(|c| *c == '_').count();
    let mut result = String::with_capacity(term.len() - underscore_count);
    let mut at_new_word = uppercase_first_letter;

    for c in term.chars().skip_while(|&c| c == '_') {
        if c == '_' {
            at_new_word = true;
        } else if at_new_word {
            result.push(c.to_ascii_uppercase());
            at_new_word = false;
        } else {
            result.push(c);
        }
    }

    result
}

#[inline]
fn is_ascii_uppercase(c: char) -> bool {
    c >= 'A' && c <= 'Z'
}
