//! What chro knows about a document without opening it: the name it is shown
//! under, and the metadata declared in its frontmatter.
//!
//! Both are answers every layer needs and every layer used to answer for
//! itself — the file tree, the view engine, and the name index each had their
//! own idea of what a document is called, so the same file appeared under
//! different names depending on which surface listed it. This crate is the one
//! place those rules live.

pub mod frontmatter;
pub mod name;
