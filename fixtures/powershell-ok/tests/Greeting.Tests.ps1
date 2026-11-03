BeforeAll {
  . (Join-Path $PSScriptRoot '..' 'Greeting.ps1')
}

Describe 'Get-Greeting' {
  It 'fixture passes' {
    Get-Greeting -Name 'Ward' | Should -Be 'Hello, Ward'
  }
}
